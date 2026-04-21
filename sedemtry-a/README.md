# Sedemtry-A

WebSocket multiplexer. Alternative to Wisp with improvements:
- Varint stream IDs (no 65535 cap)
- Explicit byte-level flow control ACKs
- Built-in ping/pong keepalive
- INFO frame on connect (version, extensions, window size)
- TCP + UDP support
- Port allowlist configurable

## Run

```
npm install
npm start
# or with any port allowed:
npm run start:any-port
```

Environment variables: `PORT` (default 3000), `HOST` (default 0.0.0.0), `ALLOW_ANY_PORT` (0/1), `LOG` (1/0)

## Protocol

Endpoint URL must end with `/`. Connect via `ws://host:port/`.

### Packet layout (all little-endian)

```
[1 byte: type] [varint: stream ID] [varint: payload length] [N bytes: payload]
```

### Types

| Hex  | Name    | Direction     |
|------|---------|---------------|
| 0x01 | CONNECT | client→server |
| 0x02 | DATA    | both          |
| 0x03 | ACK     | both          |
| 0x04 | CLOSE   | both          |
| 0x05 | PING    | both          |
| 0x06 | PONG    | both          |
| 0x07 | INFO    | server→client |

### CONNECT payload

```
[1 byte: stream type (0x01=TCP 0x02=UDP)] [2 bytes LE: port] [N bytes: hostname UTF-8]
```

### ACK payload

```
[4 bytes LE: bytes consumed]
```

### CLOSE payload

```
[1 byte: reason code]
```
