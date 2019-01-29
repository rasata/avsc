/* jshint esversion: 6, node: true */

'use strict';

const {Channel, Packet, Trace} = require('../channel');
const {Router} = require('../router');
const {Service} = require('../service');
const utils = require('../utils');

const debug = require('debug');
const {EventEmitter} = require('events');
const stream = require('stream');

const {SystemError} = utils;
const d = debug('@avro/services:codecs:netty');

// Service used to emit ping requests for discovering remote protocols.
const discoveryService = new Service({
  protocol: 'avro.netty.DiscoveryService',
});

// Header key used to store response from "discovery pings".
const PROTOCOLS_HEADER = 'avro.protocols';

// Keys used for propagating trace information (from the client to the server)
// in request handshakes' meta field. If the keys are absent in a request, the
// server's trace will simply not have the corresponding field.
const DEADLINE_META = 'avro.trace.deadline';
const LABELS_META = 'avro.trace.labels';

/**
 * Build a netty connection backed router.
 *
 * When the connection points to a `NettyGateway`, the returned router will
 * support all services available in the gateway. When used on another type of
 * connection, the router will automatically fall back to the server's single
 * service.
 */
function nettyRouter(readable, writable, opts, cb) {
  if (!isStream(writable)) {
    cb = opts;
    opts = writable;
    writable = readable;
  }
  if (!cb && typeof opts == 'function') {
    cb = opts;
    opts = undefined;
  }

  const bridge = new NettyBridge(readable, writable).on('error', onPing);
  const chan = bridge._channel;

  const trace = new Trace(opts && opts.timeout);
  let called = false;
  let router;
  chan.ping(trace, discoveryService, onPing);

  function onPing(err, remoteSvc, headers) {
    if (called) {
      return;
    }
    called = true;
    if (err) {
      d('Discovery failed: %s', err);
      cb(err);
      return;
    }
    const header = headers[PROTOCOLS_HEADER];
    let svcs;
    if (!header) { // Likely not a gateway, assume single service.
      svcs = [remoteSvc];
    } else {
      svcs = [];
      try {
        for (const ptcl of JSON.parse(utils.stringType.fromBuffer(header))) {
          svcs.push(new Service(ptcl));
        }
      } catch (err) {
        cb(err);
        return;
      }
    }
    d('Discovered %s protocol(s).', svcs.length);
    bridge.removeListener('error', onPing);
    cb(null, new NettyRouter(svcs, bridge));
  }
}

/** A netty-backed router implementation. */
class NettyRouter extends Router {
  constructor(svcs, bridge) {
    super(svcs, (svc, ...args) => { bridge._channel.call(...args); });
    this.bridge = bridge
      .on('error', (err) => { this.emit('error', err); })
      .once('close', () => { this.close(); });
    this.once('close', () => { bridge.close(); });
  }
}

/**
 * Bridge between a channel and netty connection.
 *
 * This class is used internally by the `NettyRouter` to hold connection state,
 * etc.
 */
class NettyBridge extends EventEmitter {
  constructor(readable, writable) {
    if (!isStream(writable)) {
      writable = readable;
    }
    super();

    this.closed = false;
    this._readable = readable;
    this._writable = writable;
    this._encoder = new NettyEncoder(utils.handshakeRequestType);
    this._decoder = new NettyDecoder(utils.handshakeResponseType);
    this._serverServices = new Map(); // Keyed by _remote_ hash.
    this._hashes = new Map(); // Client hash to server hash.
    this._callbacks = new Map();

    // Input/output handlers. We keep reference to them to be able to remove
    // them when the bridge is destroyed.
    this._onReadableEnd = () => {
      d('Bridge readable end.');
      if (!this.closed) {
        this.destroy(new Error('readable socket ended before writable'));
      }
    };
    this._onReadableError = (err) => {
      d('Bridge readable error: %s', err);
      this.destroy(err);
    };
    this._onWritableError = (err) => {
      d('Bridge writable error: %s', err);
      this.destroy(err);
    }
    this._onWritableFinish = () => {
      d('Bridge writable finished.');
      this.close();
    };

    this._encoder
      .on('error', (err) => {
        d('Bridge encoder error: %s', err);
        this.destroy(err);
      })
      .pipe(this._writable)
      .on('finish', this._onWritableFinish);

    if (this._readable !== this._writable) {
      this._writable.on('error', onWritableError);
    }

    this._readable
      .on('error', this._onReadableError)
      .on('end', this._onReadableEnd)
      .pipe(this._decoder)
      .on('error', (err) => {
        d('Bridge decoder error: %s', err);
        this.destroy(err);
      })
      .on('data', ({handshake, id, packet}) => {
        let obj = this._callbacks.get(id);
        if (!obj) {
          d('No bridge callback for packet %s, ignoring.', id);
          return;
        }
        const match = handshake.match;
        const clientSvc = obj.preq.service;
        const clientHash = clientSvc.hash;
        let serverSvc;
        if (handshake.serverHash || handshake.serverProtocol) {
          const serverHash = handshake.serverHash.toString('binary');
          try {
            serverSvc = new Service(JSON.parse(handshake.serverProtocol));
          } catch (err) {
            destroy(err); // Fatal error.
            return;
          }
          // IMPORTANT: `serverHash` might be different from `serverSvc.hash`.
          // The remove server might use a different algorithm to compute it.
          this._serverServices.set(serverHash, serverSvc);
          this._hashes.set(clientHash, serverHash);
        } else {
          const serverHash = this._hashes.get(clientHash);
          serverSvc = serverHash ?
            this._serverServices.get(serverHash) :
            clientSvc;
        }
        if (match === 'NONE' && !obj.retried) {
          d('Retrying packet %s (handshake did not match).', id);
          obj.retried = true;
          this._send(obj.preq, obj.meta, true);
          return;
        }
        d('Received response to packet %s.', id);
        obj.cb(null, new Packet(id, serverSvc, packet.body, packet.headers));
      });
  }

  /** Cache of protocol hash to service. */
  get knownServices() {
    return this._serverServices;
  }

  /**
   * Prevent new messages from being sent over.
   *
   * This will also cause the underlying streams to be released once no more
   * messages are in-flight.
   */
  close() {
    if (this.closed) {
      return;
    }
    d('Closing bridge.');
    this.closed = true;
    this.emit('close');
  }

  /**
   * Close the bridge, interrupting any pending calls.
   *
   * This will cause the underlying streams to be released immediately.
   */
  destroy(err) {
    this.close();
    const interruptErr = new Error('bridge destroyed');
    for (const obj of this._callbacks.values()) {
      obj.cb(interruptErr);
    }
    if (err) {
      this.emit('error', err);
    }
  }

  get _channel() {
    return new Channel((trace, preq, cb) => {
      const meta = this._track(trace, preq, cb);
      this._send(preq, meta, false);
    });
  }

  _send(preq, meta, includePtcl) {
    const clientSvc = preq.service;
    const serverHash = this._hashes.get(clientSvc.hash) || clientSvc.hash;
    let handshake = {
      clientHash: Buffer.from(clientSvc.hash, 'binary'),
      serverHash: Buffer.from(serverHash, 'binary'),
      meta,
    };
    let suffix = '';
    if (includePtcl) {
      handshake.clientProtocol = JSON.stringify(clientSvc.protocol);
      suffix = ' with client protocol';
    }
    d('Sending packet %s%s.', preq.id, suffix);
    const packet = new NettyPacket(preq.body, preq.headers);
    this._encoder.write({handshake, id: preq.id, packet});
  }

  _track(trace, preq, cb) {
    if (this.closed) {
      cb(new Error('bridge closed'));
      return;
    }
    const id = preq.id;
    d('Tracking packet request %s.', id);
    const meta = {};
    try {
      meta[LABELS_META] = utils.mapOfJsonType.toBuffer(trace.labels);
    } catch (err) {
      cb(err);
      return;
    }
    if (trace.deadline) {
      meta[DEADLINE_META] = utils.dateTimeType.toBuffer(trace.deadline);
    }
    const cleanup = trace.onceInactive(() => { this._untrack(id); });
    this._callbacks.set(id, {
      cb: (...args) => {
        if (cleanup()) {
          this._untrack(id);
          cb(...args);
        }
      },
      meta,
      preq, // For retries.
      retried: false,
    });
    return meta;
  }

  _untrack(id) {
    this._callbacks.delete(id);
    if (this.closed && !this._callbacks.size) {
      this._release();
    }
  }

  _release() {
    d('Releasing bridge.');
    this._readable
      .unpipe(this._decoder)
      .removeListener('error', this._onReadableError)
      .removeListener('end', this._onReadableEnd);
    this._encoder.unpipe(this._writable);
    this._writable
      .removeListener('error', this._onWritableError)
      .removeListener('finish', this._onWritableFinish);
    this._readable = null;
    this._writable = null;
  }
}

/**
 * Netty connection to channel bridge.
 *
 * Note that when a request packet omits its handshake, the previous packet's
 * service will be used. This will work correctly when only clients from a
 * single service connect to this bridge, but likely won't otherwise.
 */
class NettyGateway {
  constructor(router) {
    this.router = router;
    this._clientServices = new Map(); // Keyed by hash.
    for (const svc of router.services) {
      this._clientServices.set(svc.hash, svc);
    }
  }

  /** Cache of protocol hash to service, saves handshake requests. */
  get knownServices() {
    return this._clientServices;
  }

  /** Accept a connection. */
  accept(readable, writable) {
    if (!isStream(writable)) {
      writable = readable;
    }

    const router = this.router;
    let clientSvc = null; // Last one seen (for stateful connections).

    const decoder = new NettyDecoder(utils.handshakeRequestType);
    readable
      .on('error', onReadableError)
      .on('end', onReadableEnd)
      .pipe(decoder)
      .on('data', ({handshake: hreq, id, packet}) => {
        if (!hreq && !clientSvc) {
          d('Dropping packet %s, no handshake or client service.', id);
          readable.emit('error', new Error('expected handshake'));
          return;
        }
        let hres = null;
        let trace;
        if (hreq) {
          hres = {match: 'BOTH'};
          const deadlineBuf = hreq.meta && hreq.meta[DEADLINE_META];
          let deadline;
          if (deadlineBuf) {
            try {
              deadline = utils.dateTimeType.fromBuffer(deadlineBuf);
            } catch (err) {
              d('Bad deadline in packet %s: %s', id, err);
              readable.emit('error', err);
              return;
            }
          }
          trace = new Trace(deadline);
          if (!trace.active) {
            d('Packet %s is past its deadline, dropping request.', id);
            return;
          }
          const metaLabels = hreq.meta && hreq.meta[LABELS_META];
          if (metaLabels) {
            let labels;
            try {
              labels = utils.mapOfJsonType.fromBuffer(metaLabels);
            } catch (err) {
              d('Bad label in packet %s: %s', id, err);
              readable.emit('error', err);
              return;
            }
            Object.assign(trace.labels, labels);
          }
          const clientHash = hreq.clientHash.toString('binary');
          if (clientHash === discoveryService.hash) {
            d('Got protocol discovery request packet %s.', id);
            const ptcls = [];
            for (const svc of router.services) {
              ptcls.push(svc.protocol);
            }
            const str = JSON.stringify(ptcls);
            const headers = {
              [PROTOCOLS_HEADER]: utils.stringType.toBuffer(str),
            };
            const packet = new NettyPacket(Buffer.from([0]), headers);
            encoder.write({handshake: hres, id, packet});
            return;
          }
          clientSvc = this._clientServices.get(clientHash);
          if (!clientSvc) {
            if (!hreq.clientProtocol) {
              d('No service for packet %s, responding with match NONE.', id);
              // A retry will be required.
              const err = new SystemError('ERR_AVRO_UNKNOWN_CLIENT_PROTOCOL');
              hres.match = 'NONE';
              const serverSvcs = router.services;
              if (serverSvcs.size === 1) {
                // If only one server is behind this channel, we can already
                // send its protocol, otherwise we will have to wait for the
                // client protocol's name to tell which one to send back.
                hres.serverProtocol = JSON.stringify(serverSvcs[0].protocol);
                hres.serverHash = Buffer.from(serverSvc.hash, 'binary');
              }
              const packet = NettyPacket.forSystemError(err);
              encoder.write({handshake: hres, id, packet});
              return;
            }
            try {
              clientSvc = new Service(JSON.parse(hreq.clientProtocol));
            } catch (err) {
              d('Bad protocol in packet %s: %s', id, err);
              readable.emit('error', err);
              return;
            }
            d('Set client service from packet %s.', id);
            this._clientServices.set(clientHash, clientSvc);
          }
          const serverSvc = this.router.service(clientSvc);
          if (!serverSvc) {
            d('Unknown server hash in packet %s, sending protocol.', id);
            hres.match = 'CLIENT';
            hres.serverProtocol = JSON.stringify(serverSvc.protocol);
            hres.serverHash = Buffer.from(serverSvc.hash, 'binary');
          }
        }
        const preq = new Packet(id, clientSvc, packet.body, packet.headers);
        router.channel.call(trace, preq, (err, pres) => {
          if (!writable) {
            if (err) {
              d('Dropping error response %s (writable finished): %s', id, err);
            } else {
              d('Dropping OK response %s (writable finished).', id);
            }
            return;
          }
          if (err) {
            d('Error while responding to packet %s: %s', id, err);
            err = SystemError.orCode('ERR_AVRO_CHANNEL_FAILURE', err);
            const headers = pres ? pres.headers : undefined;
            const packet = NettyPacket.forSystemError(err, headers);
            encoder.write({handshake: hres, id, packet});
            close();
            return;
          }
          const packet = new NettyPacket(pres.body, pres.headers);
          encoder.write({handshake: hres, id, packet});
        });
      })
      .on('error', (err) => {
        d('Gateway decoder error: %s', err);
        router.emit('error', err);
      });

    const encoder = new NettyEncoder(utils.handshakeResponseType);
    encoder
      .on('error', (err) => {
        d('Gateway encoder error: %s', err);
        router.emit('error', err);
      })
      .pipe(writable)
      .on('finish', onWritableFinish);

    if (readable !== writable) {
      writable.on('error', onWritableError);
    }

    function onReadableEnd() {
      d('Gateway readable end.');
      close();
    }

    function onReadableError(err) {
      d('Gateway readable error: %s', err);
      close();
      router.emit('error', err);
    }

    function onWritableError(err) {
      d('Gateway writable error: %s', err);
      close();
      router.emit('error', err);
    }

    function onWritableFinish() {
      d('Gateway writable finished.');
      close();
    }

    function close() {
      if (!readable) {
        return; // Already destroyed.
      }
      d('Destroying gateway channel.');
      readable
        .unpipe(decoder)
        .removeListener('error', onReadableError)
        .removeListener('end', onReadableEnd);
      encoder.unpipe(writable);
      writable
        .removeListener('error', onWritableError)
        .removeListener('finish', onWritableFinish);
      readable = null;
      writable = null;
    }
  }
}

class NettyDecoder extends stream.Transform {
  constructor(handshakeType) {
    super({readableObjectMode: true});
    this._expectHandshake = true;
    this._handshakeType = handshakeType;
    this._id = undefined;
    this._frameCount = 0;
    this._buf = Buffer.alloc(0);
    this._bufs = [];
    this.on('finish', () => { this.push(null); });
  }

  _transform(buf, encoding, cb) {
    buf = Buffer.concat([this._buf, buf]);

    while (true) {
      if (this._id === undefined) {
        if (buf.length < 8) {
          this._buf = buf;
          cb();
          return;
        }
        this._id = buf.readInt32BE(0);
        this._frameCount = buf.readInt32BE(4);
        buf = buf.slice(8);
      }

      let frameLength;
      while (
        this._frameCount &&
        buf.length >= 4 &&
        buf.length >= (frameLength = buf.readInt32BE(0)) + 4
      ) {
        this._frameCount--;
        this._bufs.push(buf.slice(4, frameLength + 4));
        buf = buf.slice(frameLength + 4);
      }

      if (this._frameCount) {
        this._buf = buf;
        cb();
        return;
      } else {
        let obj;
        try {
          obj = this._decode(this._id, Buffer.concat(this._bufs));
        } catch (err) {
          this.emit('error', err);
          return;
        }
        this._bufs = [];
        this._id = undefined;
        this.push(obj);
      }
    }
  }

  _decode(id, buf) {
    const handshakeType = this._handshakeType;
    let handshake, packet;
    try {
      decode(this._expectHandshake);
    } catch (err) {
      d('Failed to decode with%s handshake, retrying...',
        this._expectHandshake ? '' : 'out');
      decode(this._expectHandshake);
    }
    if (!handshake && this._expectHandshake) {
      d('Switching to handshake-free mode.');
      this._expectHandshake = false;
    }
    d('Decoded packet %s', id);
    return {handshake, id, packet};

    function decode(withHandshake) {
      let body;
      if (withHandshake) {
        const obj = handshakeType.decode(buf, 0);
        if (obj.offset < 0) {
          throw new Error('truncated packet handshake');
        }
        handshake = obj.value;
        body = buf.slice(obj.offset);
      } else {
        handshake = null;
        body = buf;
      }
      packet = NettyPacket.forPayload(body);
    }
  }

  _flush() {
    if (this._buf.length || this._bufs.length) {
      const bufs = this._bufs.slice();
      bufs.unshift(this._buf);
      const err = new Error('trailing data');
      // Attach the data to help debugging (e.g. if the encoded bytes contain a
      // human-readable protocol like HTTP).
      err.trailingData = Buffer.concat(bufs);
      this.emit('error', err);
    }
  }
}

class NettyEncoder extends stream.Transform {
  constructor(handshakeType) {
    super({writableObjectMode: true});
    this._handshakeType = handshakeType;
    this.on('finish', () => { this.push(null); });
  }

  _encode(obj) {
    d('Encoding packet %s', obj.id);
    const bufs = [obj.packet.toPayload()];
    if (obj.handshake) {
      bufs.unshift(this._handshakeType.toBuffer(obj.handshake));
    }
    return bufs;
  }

  _transform(obj, encoding, cb) {
    let bufs;
    try {
      bufs = this._encode(obj);
    } catch (err) {
      cb(err);
      return;
    }
    // Header: [ ID, number of frames ]
    const headBuf = Buffer.alloc(8);
    headBuf.writeInt32BE(obj.id, 0);
    headBuf.writeInt32BE(bufs.length, 4);
    this.push(headBuf);
    // Frames, each: [ length, bytes ]
    for (const buf of bufs) {
      this.push(intBuffer(buf.length));
      this.push(buf);
    }
    cb();
  }
}

class NettyPacket {
  constructor(body, headers) {
    this.body = body;
    this.headers = headers || {};
  }

  toPayload() {
    const type = utils.mapOfBytesType;
    return Buffer.concat([type.toBuffer(this.headers), this.body]);
  }

  static forPayload(buf) {
    const pkt = new NettyPacket();
    let obj;
    obj = utils.mapOfBytesType.decode(buf, 0);
    if (obj.offset < 0) {
      throw new Error('truncated request headers');
    }
    pkt.headers = obj.value;
    pkt.body = buf.slice(obj.offset);
    return pkt;
  }

  static forSystemError(err, headers) {
    const buf = utils.systemErrorType.toBuffer(err);
    const body = Buffer.concat([Buffer.from([1, 0]), buf]);
    return new NettyPacket(body, headers);
  }
}

function intBuffer(n) {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(n);
  return buf;
}

function isStream(any) {
  return any && typeof any.pipe == 'function';
}

module.exports = {
  Gateway: NettyGateway,
  router: nettyRouter,
};
