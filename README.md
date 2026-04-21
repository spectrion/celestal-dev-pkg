# Celestial Dev Package

All three Sedemtry components plus Celestial proxy in one package.

| Component     | Dir          | Purpose                                |
|---------------|--------------|----------------------------------------|
| Sedemtry-A    | sedemtry-a/  | WebSocket multiplexer (Wisp alternative) |
| Sedemtry-B    | sedemtry-b/  | CORS bypass + TLS tunnel (Epoxy alternative) |
| Celestial     | celestial/   | Netlify-deployable web proxy           |

## Quick start

```
cd sedemtry-a && npm install && npm start   # port 3000
cd sedemtry-b && npm install && npm start   # port 3001
# Deploy celestial/ to Netlify via drag-and-drop
```

## Celestial SW registration

```js
navigator.serviceWorker.register('/celestial-sw.js?bare=/.netlify/functions/bare&prefix=/celestial/', { scope: '/' });
```

## Sedemtry-B CORS usage

```
GET http://your-server:3001/<url-encoded-target>
```

## Sedemtry-A WS connection

Connect to `ws://your-server:3000/` — server sends INFO frame, then send CONNECT packets.
