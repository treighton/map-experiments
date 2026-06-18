# WebSocket Transport Adapters — Design

**Date:** 2026-06-18
**Status:** Approved design, ready for implementation planning
**Builds on:** Plan A (`2026-06-18-syncclient-server-design.md`) and Plan B
(`2026-06-18-syncclient-server-relay-design.md`) — the sync protocol, SyncSession,
SyncClient, SyncServer, and the transport-agnostic `Connection` interface.

## Overview

The final deferred piece of the sync layer: real WebSocket transport adapters so
sync runs over an actual network. A browser `WebSocket` adapter for the PWA
client, a Node `ws` socket adapter, and a Node `ws.Server` listener that feeds
incoming sockets to `SyncServer.accept()`. Plus the one `Connection` interface
change the Plan B review required (`isOpen()`) and the SyncClient async-open and
flapping-reset fixes it enables.

## Goals

- A browser-side `Connection` adapter wrapping the native `WebSocket` global
  (dependency-free) for the PWA client.
- A Node-side `Connection` adapter wrapping a `ws` socket (used by the server per
  connection, and as the client in the integration test).
- A Node `ws.Server` listener that calls `SyncServer.accept()` per incoming socket.
- Resolve the async-open digest-loss trap via an honest `isOpen()` on `Connection`.
- Resolve the flapping-reset trap: reset backoff on handshake progress, not bare
  open.
- A real-localhost-socket integration test proving the full stack converges over
  the wire — the first time sync runs over an actual socket.

## Non-Goals (v1 scope cuts — YAGNI)

- TLS / `wss://` (plain `ws://` for the field LAN; TLS is a deployment/proxy
  concern).
- Auth handshake / tokens.
- Heartbeat / ping-pong keepalive (rely on close events; can come later).
- Server-side reconnect (clients reconnect; the server just accepts).
- Message compression.

## Architecture

```
   ┌──────── PWA Client (browser) ────────┐          ┌──────── Field Server (Node) ────────┐
   │ SyncClient                            │          │ SyncServer                           │
   │  connect: () => BrowserWebSocketConn  │  ws://   │  WebSocketSyncServer (ws listener)   │
   │    wraps native WebSocket ────────────┼─────────►│   per socket → SyncServer.accept(conn)│
   └────────────────────────────────────────┘          └────────────────────────────────────┘
                                                         (NodeWebSocketConnection also wraps a
                                                          client socket in the integration test)
```

Three new units, all behind the `Connection` contract:
- `BrowserWebSocketConnection` — wraps the browser `WebSocket` global
  (dependency-free).
- `NodeWebSocketConnection` — wraps a Node `ws` socket (server per-connection, and
  the client in the integration test).
- `WebSocketSyncServer` — a Node `ws.Server` listener building a
  `NodeWebSocketConnection` per incoming socket and calling `SyncServer.accept()`.

## The `isOpen()` Interface Change

`Connection` gains one method:

```typescript
export interface Connection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  isOpen(): boolean; // NEW
  close(): void;
}
```

Every implementation answers truthfully:
- `MemoryEndpoint` → `this.opened && !this.closed` (open after `.open()`).
- `BrowserWebSocketConnection` → `ws.readyState === WebSocket.OPEN`.
- `NodeWebSocketConnection` → `ws.readyState === ws.OPEN`.

The existing in-memory semantics are unchanged (still opens on `.open()`); a couple
of `isOpen()` assertions are added to `connection.test.ts`.

## SyncClient Async-Open & Flapping-Reset Fixes

**Async-open (digest-loss trap):** replace the unconditional immediate
`startOnce()` in `connectNow()` with an `isOpen()`-gated start:

```typescript
    conn.onOpen(startOnce);
    conn.onClose(() => this.onDisconnect());
    if (conn.isOpen()) startOnce(); // already-open (in-memory): start now
    // else: wait for onOpen (a real WebSocket while CONNECTING)
```

In-memory connections (opened by test factories) take the immediate path; a real
WebSocket (CONNECTING) waits for `onOpen`. This deletes the eager-start TODO.

**Test-factory churn:** every SyncClient/SyncServer test that builds a
`connectionPair()` and relies on synchronous delivery must now `.open()` the
endpoint(s) so `isOpen()` is true and the synchronous handshake still runs. These
are mechanical edits; all existing tests stay green after them.

**Flapping-reset:** currently `startOnce()` resets the backoff `attempt` to 0 on
*open*, so a socket that opens-then-immediately-drops never backs off. Fix: reset
`attempt` only on handshake *progress* — the first inbound message, not bare open.
`SyncClient` registers its own `onMessage` listener (in addition to the session's)
that resets `attempt` once on first inbound. A flapping socket that opens but never
exchanges a message keeps backing off. (The `startOnce` attempt-reset is removed;
`start()` still resets attempt for a fresh client start.)

## Adapters

**`BrowserWebSocketConnection`** (dependency-free):

```typescript
class BrowserWebSocketConnection implements Connection {
  constructor(url: string); // new WebSocket(url) internally
  // ws.onmessage→onMessage handlers (event.data as string), ws.onopen→onOpen,
  //   ws.onclose→onClose
  // send(d): if readyState === OPEN ws.send(d); else drop
  // isOpen(): ws.readyState === OPEN
  // close(): ws.close()
}
```

A minimal local type declares just the `WebSocket` surface used (`readyState`,
`OPEN`, `send`, `close`, `onopen`/`onmessage`/`onclose`, event `.data`), so it
typechecks in the Node-oriented tsconfig without pulling in `lib.dom`.

**`NodeWebSocketConnection`** (wraps a Node `ws` socket):

```typescript
class NodeWebSocketConnection implements Connection {
  constructor(ws: WebSocket /* from "ws" */); // wraps an existing socket
  // ws.on("message", ...)→onMessage (Buffer→string), ws.on("open")→onOpen,
  //   ws.on("close")→onClose, ws.on("error")→treat as close
  // send(d): if readyState === ws.OPEN ws.send(d); else drop
  // isOpen(): ws.readyState === ws.OPEN
  // close(): ws.close()
}
```

Used two ways: the server wraps each incoming socket; the integration test wraps a
client socket (`new WebSocket("ws://localhost:port")`).

**`WebSocketSyncServer`** (Node listener):

```typescript
class WebSocketSyncServer {
  constructor(syncServer: SyncServer, opts: { port: number });
  start(): Promise<void>; // ws.Server listens; on "connection" → accept(new NodeWebSocketConnection(sock))
  stop(): Promise<void>;  // close the ws.Server
}
```

**Contract both adapters honor:** `send()` swallows when not OPEN (matching
`MemoryEndpoint`'s drop-when-closed behavior the relay-to-dead-sibling handling
relies on). The real socket's async open means the digest only flows after
`onOpen` — handled by the `isOpen()`-gated start.

## File Structure

| File | Responsibility |
|---|---|
| `src/connection.ts` (modify) | Add `isOpen()` to interface + `MemoryEndpoint` |
| `src/syncClient.ts` (modify) | `isOpen()`-gated start; reset `attempt` on first inbound (not open) |
| `src/browserWebSocketConnection.ts` (new) | Browser `WebSocket` adapter + minimal local WS type |
| `src/nodeWebSocketConnection.ts` (new) | Node `ws` socket adapter |
| `src/webSocketSyncServer.ts` (new) | Node `ws.Server` listener → `accept` |
| `src/index.ts` (modify) | Export the new public surface |
| `package.json` (modify) | Add `ws` + `@types/ws` deps |
| `tests/connection.test.ts` (modify) | `isOpen()` assertions |
| `tests/syncClient.test.ts` / `syncServer.test.ts` / `syncMultiPeer.test.ts` (modify) | `.open()` the pair in factories |
| `tests/browserWebSocketConnection.test.ts` (new) | fake-WS contract tests |
| `tests/nodeWebSocketConnection.test.ts` (new) | fake-WS contract tests |
| `tests/webSocketIntegration.test.ts` (new) | real-localhost-socket round-trip |

## Error Handling

- **send() while CONNECTING/CLOSING** → swallow (drop), matching the in-memory
  contract.
- **Socket error event** → treat as close (fire `onClose`); SyncClient reconnects
  with backoff.
- **Server port in use / listen failure** → `start()` rejects so the caller can
  surface it.
- **Client connect to a down server** → socket fires close/error → SyncClient
  backoff reconnect (the field-server-rebooting case).
- **Malformed inbound bytes** → already handled by the protocol's `parseMessage`
  boundary; the adapter passes strings through.

## Testing Strategy

- **`BrowserWebSocketConnection` (fake WS):** onMessage/onOpen/onClose mapping;
  `send` drops while CONNECTING, sends while OPEN; `isOpen()` tracks readyState;
  `close()` calls `ws.close()`.
- **`NodeWebSocketConnection` (fake WS):** the same contract checks; error event
  treated as close.
- **`WebSocketSyncServer` + real socket integration:** start a
  `WebSocketSyncServer` on an ephemeral port; connect a real `ws` client wrapped in
  `NodeWebSocketConnection`, drive a `SyncClient` through it; create a feature on
  the client store; assert it converges to the server store over a real socket;
  then a second client converges with the first via the server. Clean shutdown.
- **SyncClient flapping-reset:** a connection that opens but sends nothing keeps
  `attempt` climbing across reconnects (backoff grows); a connection that delivers
  an inbound message resets it.
