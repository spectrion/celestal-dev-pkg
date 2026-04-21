'use strict';

const http = require('http');
const { makeServer } = require('./server');

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LOG  = process.env.LOG !== '0';
const ALLOW_ANY_PORT = process.env.ALLOW_ANY_PORT === '1';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null;

const logger = LOG ? (e, d) => process.stdout.write(`[sedemtry-b] ${e} ${d || ''}\n`) : null;

const { handleHttpRequest, handleUpgrade } = makeServer({
  logger,
  allowAnyTunnelPort: ALLOW_ANY_PORT,
  allowedOrigins: ALLOWED_ORIGINS,
});

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/' && req.method === 'GET' && !req.headers['upgrade']) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: 'sedemtry-b', version: '1.0.0', modes: ['http-cors', 'ws-tunnel'] }));
    return;
  }
  handleHttpRequest(req, res);
});

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[sedemtry-b] listening on ${HOST}:${PORT}\n`);
  process.stdout.write(`[sedemtry-b] HTTP CORS: http://${HOST}:${PORT}/<encoded-url>\n`);
  process.stdout.write(`[sedemtry-b] WS tunnel: ws://${HOST}:${PORT}/tunnel?host=<h>&port=<p>&tls=1\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
