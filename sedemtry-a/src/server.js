'use strict';

const net   = require('net');
const dns   = require('dns').promises;
const { WebSocketServer } = require('ws');
const { PACKET_TYPES, CLOSE_REASONS, STREAM_TYPES, buildPacket, parsePacket } = require('./protocol');

const DEFAULT_WINDOW    = 128;
const MAX_UDP_PAYLOAD   = 65507;
const PING_INTERVAL_MS  = 20000;
const PING_TIMEOUT_MS   = 10000;
const MAX_STREAMS       = 65536;
const ALLOWED_PORTS     = new Set([80, 443, 8080, 8443, 3000, 4000, 8000, 1935, 554]);

function makeServer(opts = {}) {
  const {
    allowedPorts = ALLOWED_PORTS,
    allowAnyPort = false,
    maxStreams   = MAX_STREAMS,
    pingInterval = PING_INTERVAL_MS,
    pingTimeout  = PING_TIMEOUT_MS,
    window       = DEFAULT_WINDOW,
    onConnect    = null,
    onClose      = null,
    logger       = null,
  } = opts;

  const log = logger || (() => {});

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const remoteAddr = req.socket.remoteAddress;
    log('connect', remoteAddr);
    if (onConnect) onConnect(req);

    const streams = new Map();
    let closed = false;
    let pingTimer = null;
    let pingPendingTimer = null;
    let leftover = Buffer.alloc(0);

    function send(buf) {
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(buf); } catch {}
    }

    function sendClose(streamId, reason) {
      const payload = Buffer.alloc(1);
      payload[0] = reason;
      send(buildPacket(PACKET_TYPES.CLOSE, streamId, payload));
    }

    function sendAck(streamId, bytesConsumed) {
      const payload = Buffer.alloc(4);
      payload.writeUInt32LE(bytesConsumed, 0);
      send(buildPacket(PACKET_TYPES.ACK, streamId, payload));
    }

    function sendInfo() {
      const info = JSON.stringify({
        version:    'sedemtry-a/1.0',
        window,
        maxStreams,
        extensions: ['udp', 'priority', 'keepalive'],
      });
      send(buildPacket(PACKET_TYPES.INFO, 0, Buffer.from(info, 'utf8')));
    }

    function cleanupStream(streamId) {
      const st = streams.get(streamId);
      if (!st) return;
      streams.delete(streamId);
      if (st.socket) {
        st.socket.destroy();
      }
    }

    function handleConnect(streamId, payload) {
      if (streams.has(streamId)) {
        sendClose(streamId, CLOSE_REASONS.UNKNOWN);
        return;
      }
      if (streams.size >= maxStreams) {
        sendClose(streamId, CLOSE_REASONS.THROTTLED);
        return;
      }
      if (payload.length < 4) {
        sendClose(streamId, CLOSE_REASONS.UNKNOWN);
        return;
      }

      const streamType = payload[0];
      const port       = payload.readUInt16LE(1);
      const hostname   = payload.slice(3).toString('utf8');

      if (!allowAnyPort && !allowedPorts.has(port)) {
        sendClose(streamId, CLOSE_REASONS.REFUSED);
        return;
      }
      if (!hostname || hostname.length > 253) {
        sendClose(streamId, CLOSE_REASONS.DNS_ERROR);
        return;
      }

      if (streamType === STREAM_TYPES.UDP) {
        const dgram = require('dgram');
        const sock = dgram.createSocket('udp4');
        const st = { type: 'udp', socket: sock, port, hostname, recvWindow: window, sendWindow: window, bytesIn: 0 };
        streams.set(streamId, st);

        sock.on('message', (msg) => {
          if (!streams.has(streamId)) return;
          send(buildPacket(PACKET_TYPES.DATA, streamId, msg));
        });
        sock.on('error', () => {
          sendClose(streamId, CLOSE_REASONS.NETWORK_ERROR);
          cleanupStream(streamId);
        });
        sock.bind(() => {
          sendAck(streamId, window);
        });
        return;
      }

      const st = { type: 'tcp', socket: null, hostname, port, recvWindow: window, sendWindow: window, bytesIn: 0, buffer: [] };
      streams.set(streamId, st);

      dns.lookup(hostname).then(({ address }) => {
        if (!streams.has(streamId)) return;
        const sock = net.createConnection({ host: address, port, timeout: 15000 }, () => {
          st.socket = sock;
          st.buffer.forEach(chunk => sock.write(chunk));
          st.buffer = [];
          sendAck(streamId, window);
        });

        sock.on('data', (chunk) => {
          if (!streams.has(streamId)) return;
          send(buildPacket(PACKET_TYPES.DATA, streamId, chunk));
          st.bytesIn += chunk.length;
          sendAck(streamId, chunk.length);
        });

        sock.on('end', () => {
          sendClose(streamId, CLOSE_REASONS.OK);
          cleanupStream(streamId);
        });

        sock.on('error', (err) => {
          const code = err.code;
          const reason = code === 'ECONNREFUSED' ? CLOSE_REASONS.REFUSED
                       : code === 'ETIMEDOUT'    ? CLOSE_REASONS.TIMEOUT
                       : CLOSE_REASONS.NETWORK_ERROR;
          sendClose(streamId, reason);
          cleanupStream(streamId);
        });

        sock.on('timeout', () => {
          sendClose(streamId, CLOSE_REASONS.TIMEOUT);
          sock.destroy();
          cleanupStream(streamId);
        });
      }).catch(() => {
        sendClose(streamId, CLOSE_REASONS.DNS_ERROR);
        cleanupStream(streamId);
      });
    }

    function handleData(streamId, payload) {
      const st = streams.get(streamId);
      if (!st) return;

      if (st.type === 'udp') {
        st.socket.send(payload, st.port, st.hostname);
        return;
      }
      if (!st.socket) {
        st.buffer.push(payload);
        return;
      }
      st.socket.write(payload);
    }

    function handleClose(streamId) {
      sendClose(streamId, CLOSE_REASONS.OK);
      cleanupStream(streamId);
    }

    function handleAck(streamId, payload) {
      if (payload.length < 4) return;
      const st = streams.get(streamId);
      if (!st) return;
      st.sendWindow += payload.readUInt32LE(0);
    }

    function processBuffer() {
      while (leftover.length > 0) {
        const packet = parsePacket(leftover);
        if (!packet) break;
        leftover = leftover.slice(packet.totalBytes);

        const { type, streamId, payload } = packet;

        if (type === PACKET_TYPES.PING) {
          send(buildPacket(PACKET_TYPES.PONG, streamId, payload));
          continue;
        }
        if (type === PACKET_TYPES.PONG) {
          if (pingPendingTimer) { clearTimeout(pingPendingTimer); pingPendingTimer = null; }
          continue;
        }
        if (type === PACKET_TYPES.CONNECT) { handleConnect(streamId, payload); continue; }
        if (type === PACKET_TYPES.DATA)    { handleData(streamId, payload);    continue; }
        if (type === PACKET_TYPES.CLOSE)   { handleClose(streamId);            continue; }
        if (type === PACKET_TYPES.ACK)     { handleAck(streamId, payload);     continue; }
      }
    }

    function startPing() {
      pingTimer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        send(buildPacket(PACKET_TYPES.PING, 0, Buffer.alloc(8)));
        pingPendingTimer = setTimeout(() => {
          ws.terminate();
        }, pingTimeout);
      }, pingInterval);
    }

    sendInfo();
    startPing();

    ws.on('message', (data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      leftover = Buffer.concat([leftover, chunk]);
      processBuffer();
    });

    ws.on('close', () => {
      closed = true;
      if (pingTimer)        { clearInterval(pingTimer);       pingTimer = null; }
      if (pingPendingTimer) { clearTimeout(pingPendingTimer); pingPendingTimer = null; }
      streams.forEach((_, id) => cleanupStream(id));
      if (onClose) onClose(req);
      log('disconnect', remoteAddr);
    });

    ws.on('error', () => {
      ws.terminate();
    });
  });

  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  }

  return { wss, handleUpgrade };
}

module.exports = { makeServer };
