'use strict';

const net    = require('net');
const tls    = require('tls');
const dns    = require('dns').promises;
const http   = require('http');
const https  = require('https');
const { WebSocketServer } = require('ws');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':      '*',
  'Access-Control-Allow-Methods':     'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
  'Access-Control-Allow-Headers':     '*',
  'Access-Control-Expose-Headers':    '*',
  'Access-Control-Max-Age':           '86400',
};

const BLOCKED_REQ_HEADERS = new Set([
  'host','connection','keep-alive','upgrade','proxy-authorization',
  'te','trailers','transfer-encoding','via','x-forwarded-for',
  'x-forwarded-host','x-forwarded-proto','x-real-ip',
]);
const BLOCKED_RES_HEADERS = new Set([
  'content-security-policy','content-security-policy-report-only',
  'x-frame-options','x-xss-protection','x-content-type-options',
  'strict-transport-security','cross-origin-embedder-policy',
  'cross-origin-opener-policy','cross-origin-resource-policy',
  'permissions-policy','expect-ct','report-to','nel',
  'origin-agent-cluster','access-control-allow-origin',
  'access-control-allow-credentials',
]);

function decompressBuffer(buf, encoding) {
  const zlib = require('zlib');
  const enc  = (encoding || '').toLowerCase().split(',')[0].trim();
  return new Promise(resolve => {
    const cb = (e, d) => resolve(e ? buf : d);
    if (enc === 'gzip')    return zlib.gunzip(buf, cb);
    if (enc === 'deflate') return zlib.inflate(buf, (e, d) => e ? zlib.inflateRaw(buf, cb) : cb(null, d));
    if (enc === 'br')      return zlib.brotliDecompress(buf, cb);
    resolve(buf);
  });
}

function siteHeaders(hostname) {
  const h = hostname.toLowerCase();
  if (h.includes('twitch.tv') || h.includes('jtvnw'))
    return { 'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' };
  if (h.includes('discord.com') || h.includes('discordapp.com'))
    return { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
  if (h.includes('youtube.com') || h.includes('googlevideo.com') || h.includes('ytimg.com'))
    return { 'sec-fetch-site': 'same-origin' };
  if (h.includes('reddit.com'))
    return { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
  return {};
}

function isTextType(ct) {
  ct = (ct || '').toLowerCase().split(';')[0].trim();
  return ct.startsWith('text/') || [
    'application/javascript','application/x-javascript','application/json',
    'application/xml','application/xhtml+xml','application/manifest+json',
    'application/ld+json','image/svg+xml',
  ].includes(ct);
}

async function httpFetch(targetUrl, method, reqHeaders, body) {
  const url     = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const port    = url.port ? parseInt(url.port) : (isHttps ? 443 : 80);
  const lib     = isHttps ? https : http;

  const headers = {
    'host':             url.hostname,
    'user-agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language':  'en-US,en;q=0.9',
    'accept-encoding':  'gzip, deflate, br',
    'sec-ch-ua':        '"Google Chrome";v="125","Chromium";v="125","Not.A/Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest':   method === 'POST' ? 'empty' : 'document',
    'sec-fetch-mode':   method === 'POST' ? 'cors'  : 'navigate',
    'sec-fetch-site':   'none',
    'sec-fetch-user':   '?1',
    'upgrade-insecure-requests': '1',
    'cache-control':    'max-age=0',
    ...siteHeaders(url.hostname),
  };

  for (const [k, v] of Object.entries(reqHeaders || {})) {
    const kl = k.toLowerCase();
    if (!BLOCKED_REQ_HEADERS.has(kl)) headers[kl] = v;
  }

  if (body && body.length > 0) {
    headers['content-length'] = String(body.length);
    headers['sec-fetch-dest'] = 'empty';
    headers['sec-fetch-mode'] = 'cors';
    headers['sec-fetch-site'] = 'same-origin';
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = lib.request({
      method,
      hostname: url.hostname,
      port,
      path:     url.pathname + url.search,
      headers,
      rejectUnauthorized: false,
      timeout: 30000,
    }, res => {
      res.on('data',  c => chunks.push(c));
      res.on('end',   () => resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

async function tcpTunnel(hostname, port, options = {}) {
  const { tls: useTls = false, timeout = 15000 } = options;
  const address = (await dns.lookup(hostname)).address;
  return new Promise((resolve, reject) => {
    const sock = useTls
      ? tls.connect({ host: address, port, servername: hostname, rejectUnauthorized: false, timeout })
      : net.createConnection({ host: address, port, timeout });
    const onConnect = () => resolve(sock);
    sock.once('connect', onConnect);
    sock.once('secureConnect', onConnect);
    sock.once('error', reject);
  });
}

function makeServer(opts = {}) {
  const {
    allowedOrigins = null,
    logger         = null,
    maxBodySize    = 32 * 1024 * 1024,
    tunnelPorts    = new Set([80, 443, 8080, 8443]),
    allowAnyTunnelPort = false,
  } = opts;

  const log = logger || (() => {});
  const wss = new WebSocketServer({ noServer: true });

  function checkOrigin(req) {
    if (!allowedOrigins) return true;
    const origin = req.headers['origin'] || '';
    return allowedOrigins.some(o => typeof o === 'string' ? origin === o : o.test(origin));
  }

  async function handleHttpRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    let targetUrl;
    try {
      targetUrl = decodeURIComponent(req.url.slice(1));
      new URL(targetUrl);
    } catch {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ error: 'Invalid target URL' }));
      return;
    }

    const bodyChunks = [];
    let bodySize = 0;
    await new Promise(resolve => {
      req.on('data', chunk => {
        bodySize += chunk.length;
        if (bodySize <= maxBodySize) bodyChunks.push(chunk);
      });
      req.on('end', resolve);
    });
    const body = bodySize > 0 ? Buffer.concat(bodyChunks) : null;

    const fwdHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (!BLOCKED_REQ_HEADERS.has(kl)) fwdHeaders[kl] = v;
    }

    let resp;
    try {
      resp = await httpFetch(targetUrl, req.method, fwdHeaders, body);
    } catch (e) {
      res.writeHead(502, CORS_HEADERS);
      res.end(JSON.stringify({ error: e.message }));
      return;
    }

    let resBuf = resp.body;
    try { resBuf = await decompressBuffer(resBuf, resp.headers['content-encoding']); } catch {}

    const outHeaders = { ...CORS_HEADERS };
    for (const [k, v] of Object.entries(resp.headers)) {
      const kl = k.toLowerCase();
      if (!BLOCKED_RES_HEADERS.has(kl) && kl !== 'content-encoding' && kl !== 'content-length') {
        outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
      }
    }
    outHeaders['content-type']   = resp.headers['content-type'] || 'application/octet-stream';
    outHeaders['content-length'] = String(resBuf.length);

    res.writeHead(resp.statusCode, outHeaders);
    res.end(resBuf);
  }

  wss.on('connection', (ws, req) => {
    const url      = new URL(req.url, 'http://localhost');
    const mode     = url.pathname.replace(/^\/+|\/+$/g, '');
    const remoteIp = req.socket.remoteAddress;
    log('ws-connect', `${mode} ${remoteIp}`);

    if (mode === 'tunnel') {
      const hostname = url.searchParams.get('host');
      const port     = parseInt(url.searchParams.get('port') || '443', 10);
      const useTls   = url.searchParams.get('tls') !== '0';

      if (!hostname) { ws.close(4000, 'missing host'); return; }
      if (!allowAnyTunnelPort && !tunnelPorts.has(port)) { ws.close(4001, 'port not allowed'); return; }

      tcpTunnel(hostname, port, { tls: useTls }).then(sock => {
        ws.send(JSON.stringify({ ok: true, host: hostname, port, tls: useTls }));

        sock.on('data', data => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        });
        sock.on('end',   () => ws.close(1000, 'remote closed'));
        sock.on('error', ()  => ws.close(1011, 'socket error'));

        ws.on('message', data => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (sock.writable) sock.write(buf);
        });
        ws.on('close', () => sock.destroy());
      }).catch(e => {
        ws.close(4002, e.message);
      });
      return;
    }

    ws.close(4404, 'unknown mode');
  });

  function handleUpgrade(req, socket, head) {
    if (!checkOrigin(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  }

  return { handleHttpRequest, handleUpgrade, wss };
}

module.exports = { makeServer, CORS_HEADERS };
