# Sedemtry-B

CORS bypass and TLS tunnel server. Alternative to Epoxy — pure Node.js, no Rust/WASM required.

## Modes

### HTTP CORS proxy

```
GET http://your-server:3001/<url-encoded-target>
```

Returns the target response with all CORS/security headers stripped and `Access-Control-Allow-Origin: *` set. Supports gzip/deflate/brotli decompression. Full Chrome 125 fingerprint headers. Site-specific headers for YouTube, Twitch, Discord, Reddit.

### WebSocket TCP/TLS tunnel

```
ws://your-server:3001/tunnel?host=example.com&port=443&tls=1
```

Opens a raw TCP (or TLS) socket to the target host and bridges it over WebSocket. This lets browser JS do raw TCP without WASM — pipe your own TLS implementation over it.

Parameters:
- `host` — destination hostname
- `port` — destination port
- `tls`  — `1` for TLS, `0` for raw TCP

On connection the server sends a JSON confirmation frame: `{"ok":true,"host":"...","port":443,"tls":true}`
Then all subsequent frames are raw binary TCP data.

## Run

```
npm install
npm start
```

Environment variables:
- `PORT` (default 3001)
- `HOST` (default 0.0.0.0)
- `ALLOW_ANY_PORT` — set to `1` to allow any tunnel port
- `ALLOWED_ORIGINS` — comma-separated origins, unset = allow all
- `LOG` — set to `0` to disable logging
