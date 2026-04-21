'use strict';

const PACKET_TYPES = {
  CONNECT:  0x01,
  DATA:     0x02,
  ACK:      0x03,
  CLOSE:    0x04,
  PING:     0x05,
  PONG:     0x06,
  INFO:     0x07,
};

const CLOSE_REASONS = {
  OK:              0x00,
  NETWORK_ERROR:   0x01,
  DNS_ERROR:       0x02,
  REFUSED:         0x03,
  TIMEOUT:         0x04,
  THROTTLED:       0x05,
  SERVER_SHUTDOWN: 0x06,
  UNKNOWN:         0xFF,
};

const STREAM_TYPES = {
  TCP: 0x01,
  UDP: 0x02,
};

function encodeVarint(n) {
  const out = [];
  while (n > 0x7F) {
    out.push((n & 0x7F) | 0x80);
    n >>>= 7;
  }
  out.push(n & 0x7F);
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (shift >= 35) throw new Error('Varint overflow');
  }
  return { value: result, bytesRead: pos - offset };
}

function buildPacket(type, streamId, payload) {
  const typeB = Buffer.alloc(1);
  typeB[0] = type;
  const sidV = encodeVarint(streamId);
  const lenV = encodeVarint(payload ? payload.length : 0);
  return payload
    ? Buffer.concat([typeB, sidV, lenV, payload])
    : Buffer.concat([typeB, sidV, lenV]);
}

function parsePacket(buf) {
  if (buf.length < 3) return null;
  const type = buf[0];
  let off = 1;
  const sid = decodeVarint(buf, off);
  off += sid.bytesRead;
  const len = decodeVarint(buf, off);
  off += len.bytesRead;
  const payload = buf.slice(off, off + len.value);
  if (payload.length < len.value) return null;
  return { type, streamId: sid.value, payload, totalBytes: off + len.value };
}

module.exports = { PACKET_TYPES, CLOSE_REASONS, STREAM_TYPES, buildPacket, parsePacket, encodeVarint, decodeVarint };
