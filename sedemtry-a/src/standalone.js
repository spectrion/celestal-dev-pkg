'use strict';

const http = require('http');
const { makeServer } = require('./server');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_ANY_PORT = process.env.ALLOW_ANY_PORT === '1';
const LOG = process.env.LOG !== '0';

const logger = LOG ? (event, data) => process.stdout.write(`[sedemtry-a] ${event} ${data || ''}\n`) : null;

const { handleUpgrade } = makeServer({
  allowAnyPort: ALLOW_ANY_PORT,
  logger,
});

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ server: 'sedemtry-a', version: '1.0.0', protocol: 'sedemtry-mux/1' }));
});

httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url || '/';
  if (!url.endsWith('/')) {
    socket.destroy();
    return;
  }
  handleUpgrade(req, socket, head);
});

httpServer.listen(PORT, HOST, () => {
  process.stdout.write(`[sedemtry-a] listening on ${HOST}:${PORT}\n`);
});

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));
process.on('SIGINT',  () => httpServer.close(() => process.exit(0)));
