# WebSocket Transport Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real WebSocket transport adapters (browser client, Node `ws` socket, Node `ws.Server` listener) so sync runs over an actual network, plus the `isOpen()` interface change and SyncClient async-open/flapping-reset fixes they require.

**Architecture:** `Connection` gains `isOpen()`. SyncClient starts the handshake immediately only when the connection is already open (in-memory), else waits for `onOpen` (a real CONNECTING WebSocket); backoff resets on first inbound message, not bare open. Three adapters implement `Connection`: a dependency-free browser `WebSocket` wrapper, a Node `ws` socket wrapper, and a `ws.Server` listener that feeds sockets to `SyncServer.accept()`. The Node path gets a real-localhost-socket integration test; the browser adapter is verified against a fake `WebSocket`.

**Tech Stack:** TypeScript, Vitest, Node 24, `ws` + `@types/ws`. Builds on `@sartools/feature-store` (Connection, SyncClient, SyncServer, SyncSession, FeatureStore).

**Spec:** `docs/superpowers/specs/2026-06-18-websocket-adapters-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/connection.ts` (modify) | Add `isOpen()` to `Connection` + `MemoryEndpoint` |
| `src/syncClient.ts` (modify) | `isOpen()`-gated start; reset `attempt` on first inbound (not open) |
| `src/browserWebSocketConnection.ts` (new) | Browser `WebSocket` adapter + minimal local WS type |
| `src/nodeWebSocketConnection.ts` (new) | Node `ws` socket adapter |
| `src/webSocketSyncServer.ts` (new) | Node `ws.Server` listener → `accept` |
| `src/index.ts` (modify) | Export the new public surface |
| `package.json` (modify) | Add `ws` + `@types/ws` deps |
| Tests | `connection.test.ts` (isOpen), `syncClient`/`syncServer`/`syncMultiPeer` (.open() churn), `browserWebSocketConnection.test.ts`, `nodeWebSocketConnection.test.ts`, `webSocketIntegration.test.ts` |

---

## Task 1: Add `isOpen()` to Connection + MemoryEndpoint

**Files:**
- Modify: `src/connection.ts`
- Test: `tests/connection.test.ts`

- [ ] **Step 1: Append the failing tests to `tests/connection.test.ts`**

Append inside the existing `describe("connectionPair", ...)` block:

```typescript
  it("isOpen() is false before open() and true after", () => {
    const [a, b] = connectionPair();
    expect(a.isOpen()).toBe(false);
    expect(b.isOpen()).toBe(false);
    a.open();
    expect(a.isOpen()).toBe(true);
    expect(b.isOpen()).toBe(true);
  });

  it("isOpen() is false after close()", () => {
    const [a, b] = connectionPair();
    a.open();
    expect(a.isOpen()).toBe(true);
    a.close();
    expect(a.isOpen()).toBe(false);
    expect(b.isOpen()).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/connection.test.ts`
Expected: FAIL — `a.isOpen is not a function`.

- [ ] **Step 3: Add `isOpen()` to `src/connection.ts`**

Add to the `Connection` interface (after `onClose`, before `close`):
```typescript
  isOpen(): boolean;
```

Add to the `MemoryEndpoint` class (a method, near `close()`):
```typescript
  isOpen(): boolean {
    return this.opened && !this.closed;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/connection.test.ts`
Expected: PASS — all connection tests pass.

- [ ] **Step 5: Run full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: A KNOWN FAILURE may appear in syncClient/syncServer tests IF the SyncClient already used isOpen — but it does NOT yet, so all should still pass. `tsc --noEmit` exits 0. If typecheck reports that some OTHER `Connection` implementer is missing `isOpen`, there is none yet (only MemoryEndpoint), so it should be clean. Report actual result.

- [ ] **Step 6: Commit**

```bash
git add src/connection.ts tests/connection.test.ts
git commit -m "feat: add isOpen() to Connection and MemoryEndpoint"
```

---

## Task 2: SyncClient — `isOpen()`-gated start + flapping-reset on first inbound

**Files:**
- Modify: `src/syncClient.ts`
- Modify: `tests/syncClient.test.ts`
- Modify: `tests/syncServer.test.ts`
- Modify: `tests/syncMultiPeer.test.ts`

This task changes `connectNow()` to gate the immediate start on `isOpen()` and moves the backoff `attempt` reset from open to first-inbound. Because the in-memory factory connections are now NOT open by default, every test factory that builds a `connectionPair()` for a SyncClient/SyncServer must `.open()` the connection so the synchronous handshake runs.

- [ ] **Step 1: Add the flapping-reset failing test to `tests/syncClient.test.ts`**

Append a new test to the `describe("SyncClient reconnect", ...)` block. This proves a connection that OPENS but never delivers an inbound message keeps backing off (attempt is NOT reset by bare open):

```typescript
  it("does not reset backoff on bare open (only on first inbound message)", () => {
    const timer = new FakeTimer();
    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });
    const made: InMemoryConnection[] = [];
    // Connections that open but the server never responds (no inbound to client).
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      void serverConn; // no server session — client gets no inbound messages
      clientConn.open(); // opens, so the client starts, but no inbound arrives
      made.push(clientConn);
      return clientConn;
    };
    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 1, // ceiling: delay = capped * 1.0
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });
    client.start();
    made[0]!.close(); // attempt 0 → delay 1000, attempt→1
    expect(timer.lastDelay).toBe(1000);
    timer.fire();
    made[1]!.close(); // no inbound happened → attempt still 1 → delay 2000
    expect(timer.lastDelay).toBe(2000);
    timer.fire();
    made[2]!.close(); // attempt 2 → delay 4000 (backoff GROWS, not reset)
    expect(timer.lastDelay).toBe(4000);
    client.stop();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/syncClient.test.ts`
Expected: FAIL — currently `startOnce` resets attempt on open, so the second delay is 1000 (reset), not 2000.

- [ ] **Step 3: Change `connectNow()` in `src/syncClient.ts`**

Replace the entire `connectNow()` method (lines ~82-111) with:

```typescript
  private connectNow(): void {
    const conn = this.connect();
    this.conn = conn;
    const session = new SyncSession(this.store, conn);
    this.session = session;

    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      session.start();
    };

    // Reset backoff only when the handshake makes PROGRESS (first inbound
    // message), not on bare open — a flapping socket that opens then drops
    // without exchanging a message keeps backing off.
    let firstInbound = true;
    conn.onMessage(() => {
      if (firstInbound) {
        firstInbound = false;
        this.attempt = 0;
      }
    });

    conn.onOpen(startOnce);
    conn.onClose(() => this.onDisconnect());

    // Start now only if already open (in-memory). A real WebSocket is CONNECTING
    // at this point, so we wait for onOpen to avoid sending the digest into a
    // not-yet-open socket.
    if (conn.isOpen()) startOnce();
  }
```

Note: `conn.onMessage` here registers an ADDITIONAL listener; the SyncSession (constructed above) also registered its own onMessage in its constructor. Both fire — the Connection supports multiple message handlers (MemoryEndpoint pushes to an array). The client's listener only resets the backoff counter; the session's does the protocol.

- [ ] **Step 4: Update the SyncClient test factories to `.open()` the connection**

In `tests/syncClient.test.ts`, every `connect` factory that builds a `connectionPair()` must `.open()` the client connection so `isOpen()` is true and the synchronous handshake runs. The factories are at lines ~50, ~76, ~117, ~164, ~192, ~219 (the new flapping test at Step 1 already calls `clientConn.open()`).

For each factory, after building the pair and (where present) constructing the server-side session, add `clientConn.open();` before `return clientConn;`. Concretely, a factory like:
```typescript
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      const serverSession = new SyncSession(serverStore, serverConn);
      void serverSession;
      return clientConn;
    };
```
becomes:
```typescript
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      const serverSession = new SyncSession(serverStore, serverConn);
      void serverSession;
      clientConn.open();
      return clientConn;
    };
```
And a factory that only does `void serverConn;` becomes the same with `clientConn.open();` added before the return. Apply to ALL connect factories in this file. (The "offline-edit" test's factory must also `.open()` — the reconnect path re-calls connect() and the fresh connection must open for the handshake to run.)

IMPORTANT for the offline-edit test: it closes `serverConnRef` to simulate disconnect, then `timer.fire()` reconnects. Each `connect()` call builds a NEW pair and must `.open()` the new client connection. Ensure the factory calls `clientConn.open()` every time.

- [ ] **Step 5: Update `tests/syncServer.test.ts` factory**

In `tests/syncServer.test.ts`, the `connectClient` helper builds a pair and `server.accept(serverConn)`. The CLIENT side runs a `SyncSession` directly (not a SyncClient), but its handshake still needs the connection open for `isOpen()`-gated paths elsewhere — actually the client side here calls `session.start()` directly, which sends regardless of isOpen. The SERVER side (`accept`) does NOT call start() (symmetric handshake). So strictly the server tests may still pass without open(). BUT to be safe and consistent, add `clientConn.open();` in `connectClient` after `server.accept(serverConn)` and before constructing/starting the client session. Change:
```typescript
function connectClient(server: SyncServer, clientStore: FeatureStore) {
  const [clientConn, serverConn] = connectionPair();
  server.accept(serverConn);
  const session = new SyncSession(clientStore, clientConn);
  session.start();
  return { clientConn, session };
}
```
to:
```typescript
function connectClient(server: SyncServer, clientStore: FeatureStore) {
  const [clientConn, serverConn] = connectionPair();
  server.accept(serverConn);
  clientConn.open();
  const session = new SyncSession(clientStore, clientConn);
  session.start();
  return { clientConn, session };
}
```

- [ ] **Step 6: Update `tests/syncMultiPeer.test.ts` factories**

In `tests/syncMultiPeer.test.ts`, the `connectA`/`connectB` factories build a pair and `server.accept(serverConn)`. Add `clientConn.open();` before `return clientConn;` in BOTH factories. Change each:
```typescript
    const connectA = () => {
      const [clientConn, serverConn] = connectionPair();
      server.accept(serverConn);
      return clientConn;
    };
```
to:
```typescript
    const connectA = () => {
      const [clientConn, serverConn] = connectionPair();
      server.accept(serverConn);
      clientConn.open();
      return clientConn;
    };
```
(and the same for `connectB`).

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run tests/syncClient.test.ts tests/syncServer.test.ts tests/syncMultiPeer.test.ts`
Expected: PASS — including the new flapping-reset test (delays 1000→2000→4000). If a convergence test fails, a factory is missing its `.open()` call — add it. Do NOT revert the isOpen() gating.

- [ ] **Step 8: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green; typecheck exits 0. Report count.

- [ ] **Step 9: Commit**

```bash
git add src/syncClient.ts tests/syncClient.test.ts tests/syncServer.test.ts tests/syncMultiPeer.test.ts
git commit -m "feat: gate SyncClient start on isOpen(); reset backoff on first inbound"
```

---

## Task 3: Add `ws` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install `ws` and its types**

Run: `npm install ws@^8.18.0 && npm install --save-dev @types/ws@^8.5.0`
Expected: `ws` lands in `dependencies`, `@types/ws` in `devDependencies`. If `^8.18.0` is unavailable, install the latest 8.x and report the version.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws dependency for WebSocket adapters"
```

---

## Task 4: BrowserWebSocketConnection

**Files:**
- Create: `src/browserWebSocketConnection.ts`
- Test: `tests/browserWebSocketConnection.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/browserWebSocketConnection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { BrowserWebSocketConnection } from "../src/browserWebSocketConnection.js";

/** Fake browser WebSocket mimicking the surface the adapter uses. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
  // test helpers
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  fireMessage(data: string) {
    this.onmessage?.({ data });
  }
  fireClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function makeConn() {
  const ws = new FakeWebSocket();
  // Inject the fake via the optional factory arg (see implementation).
  const conn = new BrowserWebSocketConnection("ws://x", () => ws as unknown as WebSocket);
  return { ws, conn };
}

describe("BrowserWebSocketConnection", () => {
  it("isOpen() reflects readyState", () => {
    const { ws, conn } = makeConn();
    expect(conn.isOpen()).toBe(false);
    ws.fireOpen();
    expect(conn.isOpen()).toBe(true);
  });

  it("fires onOpen handlers when the socket opens", () => {
    const { ws, conn } = makeConn();
    let opened = false;
    conn.onOpen(() => (opened = true));
    ws.fireOpen();
    expect(opened).toBe(true);
  });

  it("delivers inbound messages to onMessage handlers", () => {
    const { ws, conn } = makeConn();
    const got: string[] = [];
    conn.onMessage((d) => got.push(d));
    ws.fireMessage("hello");
    expect(got).toEqual(["hello"]);
  });

  it("send() drops while CONNECTING and sends when OPEN", () => {
    const { ws, conn } = makeConn();
    conn.send("early"); // CONNECTING → dropped
    expect(ws.sent).toEqual([]);
    ws.fireOpen();
    conn.send("now"); // OPEN → sent
    expect(ws.sent).toEqual(["now"]);
  });

  it("fires onClose handlers and close() closes the socket", () => {
    const { ws, conn } = makeConn();
    let closed = false;
    conn.onClose(() => (closed = true));
    ws.fireClose();
    expect(closed).toBe(true);
    conn.close();
    expect(ws.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/browserWebSocketConnection.test.ts`
Expected: FAIL — cannot find module `../src/browserWebSocketConnection.js`.

- [ ] **Step 3: Write the implementation** at `src/browserWebSocketConnection.ts`:

```typescript
import type { Connection } from "./connection.js";

/**
 * Minimal local declaration of the browser WebSocket surface the adapter uses.
 * Keeps the package's Node-oriented tsconfig free of lib.dom while staying
 * dependency-free for the browser path.
 */
interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

const OPEN = 1;

/**
 * Connection backed by the browser's native WebSocket. Dependency-free: it uses
 * the ambient WebSocket global (overridable via the factory arg for tests).
 * send() drops while not OPEN, matching the in-memory Connection contract.
 */
export class BrowserWebSocketConnection implements Connection {
  private ws: MinimalWebSocket;
  private messageHandlers: ((data: string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  constructor(url: string, factory?: (url: string) => WebSocket) {
    const make =
      factory ??
      ((u: string) => new (globalThis as { WebSocket: new (u: string) => WebSocket }).WebSocket(u));
    this.ws = make(url) as unknown as MinimalWebSocket;
    this.ws.onopen = () => {
      for (const h of this.openHandlers) h();
    };
    this.ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      for (const h of this.messageHandlers) h(data);
    };
    this.ws.onclose = () => {
      for (const h of this.closeHandlers) h();
    };
  }

  send(data: string): void {
    if (this.ws.readyState !== OPEN) return;
    this.ws.send(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  isOpen(): boolean {
    return this.ws.readyState === OPEN;
  }

  close(): void {
    this.ws.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/browserWebSocketConnection.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/browserWebSocketConnection.ts tests/browserWebSocketConnection.test.ts
git commit -m "feat: add BrowserWebSocketConnection adapter"
```

---

## Task 5: NodeWebSocketConnection

**Files:**
- Create: `src/nodeWebSocketConnection.ts`
- Test: `tests/nodeWebSocketConnection.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/nodeWebSocketConnection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { NodeWebSocketConnection } from "../src/nodeWebSocketConnection.js";

/** Fake `ws` socket: EventEmitter-ish .on() + readyState + send/close. */
class FakeWsSocket {
  static OPEN = 1;
  OPEN = FakeWsSocket.OPEN;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  on(event: string, handler: (arg?: unknown) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(event: string, arg?: unknown) {
    for (const h of this.handlers[event] ?? []) h(arg);
  }
  fireOpen() {
    this.readyState = FakeWsSocket.OPEN;
    this.emit("open");
  }
}

function makeConn() {
  const ws = new FakeWsSocket();
  const conn = new NodeWebSocketConnection(ws as never);
  return { ws, conn };
}

describe("NodeWebSocketConnection", () => {
  it("isOpen() reflects readyState", () => {
    const { ws, conn } = makeConn();
    expect(conn.isOpen()).toBe(false);
    ws.fireOpen();
    expect(conn.isOpen()).toBe(true);
  });

  it("fires onOpen when the socket opens", () => {
    const { ws, conn } = makeConn();
    let opened = false;
    conn.onOpen(() => (opened = true));
    ws.fireOpen();
    expect(opened).toBe(true);
  });

  it("delivers inbound messages (Buffer or string) as strings", () => {
    const { ws, conn } = makeConn();
    const got: string[] = [];
    conn.onMessage((d) => got.push(d));
    ws.emit("message", Buffer.from("from-buffer"));
    ws.emit("message", "from-string");
    expect(got).toEqual(["from-buffer", "from-string"]);
  });

  it("send() drops while not OPEN and sends when OPEN", () => {
    const { ws, conn } = makeConn();
    conn.send("early");
    expect(ws.sent).toEqual([]);
    ws.fireOpen();
    conn.send("now");
    expect(ws.sent).toEqual(["now"]);
  });

  it("treats an error event as a close", () => {
    const { ws, conn } = makeConn();
    let closed = 0;
    conn.onClose(() => closed++);
    ws.emit("error", new Error("boom"));
    expect(closed).toBe(1);
  });

  it("fires onClose on close event and close() closes the socket", () => {
    const { ws, conn } = makeConn();
    let closed = 0;
    conn.onClose(() => closed++);
    ws.emit("close");
    expect(closed).toBe(1);
    conn.close();
    expect(ws.closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nodeWebSocketConnection.test.ts`
Expected: FAIL — cannot find module `../src/nodeWebSocketConnection.js`.

- [ ] **Step 3: Write the implementation** at `src/nodeWebSocketConnection.ts`:

```typescript
import type { Connection } from "./connection.js";

/**
 * Minimal structural type for the parts of a `ws` WebSocket the adapter uses.
 * Avoids a hard compile-time import of `ws` types in this file's signature while
 * remaining accurate (the real `ws.WebSocket` satisfies it).
 */
interface WsLike {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "open" | "close", handler: () => void): void;
  on(event: "error", handler: (err: unknown) => void): void;
}

/**
 * Connection backed by a Node `ws` socket. Used by the server per incoming
 * socket and as the client socket in integration tests. send() drops while not
 * OPEN; an error event is treated as a close. Inbound Buffers are decoded to
 * strings.
 */
export class NodeWebSocketConnection implements Connection {
  private messageHandlers: ((data: string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private closeFired = false;

  constructor(private ws: WsLike) {
    this.ws.on("message", (data: unknown) => {
      const str =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : String(data);
      for (const h of this.messageHandlers) h(str);
    });
    this.ws.on("open", () => {
      for (const h of this.openHandlers) h();
    });
    this.ws.on("close", () => this.fireClose());
    this.ws.on("error", () => this.fireClose());
  }

  private fireClose(): void {
    if (this.closeFired) return; // a socket may emit both error and close
    this.closeFired = true;
    for (const h of this.closeHandlers) h();
  }

  send(data: string): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  isOpen(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  close(): void {
    this.ws.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/nodeWebSocketConnection.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/nodeWebSocketConnection.ts tests/nodeWebSocketConnection.test.ts
git commit -m "feat: add NodeWebSocketConnection adapter"
```

---

## Task 6: WebSocketSyncServer (Node listener)

**Files:**
- Create: `src/webSocketSyncServer.ts`

This wraps a `ws.Server`. It is tested via the real-socket integration test in Task 7 (a fake `ws.Server` would test almost nothing — the value is the real listen/accept path). This task creates the file; Task 7 exercises it end to end.

- [ ] **Step 1: Write the implementation** at `src/webSocketSyncServer.ts`:

```typescript
import { WebSocketServer, type WebSocket } from "ws";
import type { SyncServer } from "./syncServer.js";
import { NodeWebSocketConnection } from "./nodeWebSocketConnection.js";

export interface WebSocketSyncServerOptions {
  port: number;
}

/**
 * Node `ws.Server` listener that feeds each incoming socket to SyncServer.accept
 * (wrapped in a NodeWebSocketConnection). The SyncServer holds the shared store
 * and relays among connected clients.
 */
export class WebSocketSyncServer {
  private wss: WebSocketServer | null = null;

  constructor(
    private syncServer: SyncServer,
    private opts: WebSocketSyncServerOptions,
  ) {}

  /** Begin listening. Resolves once the server is listening; rejects on error. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port });
      this.wss = wss;
      wss.on("connection", (socket: WebSocket) => {
        this.syncServer.accept(new NodeWebSocketConnection(socket));
      });
      wss.on("listening", () => resolve());
      wss.on("error", (err) => reject(err));
    });
  }

  /** Stop listening and close all sockets. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
      this.wss = null;
    });
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: exits 0. (The `ws` types resolve via `@types/ws` from Task 3.)

- [ ] **Step 3: Commit**

```bash
git add src/webSocketSyncServer.ts
git commit -m "feat: add WebSocketSyncServer listener"
```

---

## Task 7: Real-socket integration test (the milestone)

**Files:**
- Test: `tests/webSocketIntegration.test.ts`

Proves the full stack converges over a real localhost socket: SyncClient → NodeWebSocketConnection (client) → real ws → WebSocketSyncServer → SyncServer.

- [ ] **Step 1: Write the test** at `tests/webSocketIntegration.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { FeatureStore } from "../src/featureStore.js";
import { SyncServer } from "../src/syncServer.js";
import { WebSocketSyncServer } from "../src/webSocketSyncServer.js";
import { SyncClient } from "../src/syncClient.js";
import { NodeWebSocketConnection } from "../src/nodeWebSocketConnection.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };
const PORT = 38271; // ephemeral-ish fixed port for the test

/** Poll until predicate() is true or timeout. Real sockets are async. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("WebSocket integration (real localhost socket)", () => {
  let wsServer: WebSocketSyncServer | null = null;
  const clients: SyncClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.stop();
    clients.length = 0;
    if (wsServer) await wsServer.stop();
    wsServer = null;
  });

  it("a client converges with the server store over a real socket", async () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const syncServer = new SyncServer(serverStore);
    wsServer = new WebSocketSyncServer(syncServer, { port: PORT });
    await wsServer.start();

    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });
    const client = new SyncClient({
      store: clientStore,
      connect: () => new NodeWebSocketConnection(new WebSocket(`ws://localhost:${PORT}`)),
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (h) => clearTimeout(h as unknown as NodeJS.Timeout),
      random: () => 0.5,
    });
    clients.push(client);
    client.start();

    // Create a feature on the client; it should reach the server store.
    clientStore.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "over-the-wire",
      color: "",
    });

    await waitFor(() => serverStore.getRaw("c1")?.properties.label === "over-the-wire");
    expect(serverStore.getRaw("c1")?.properties.label).toBe("over-the-wire");
  });

  it("two clients converge with each other through the server over real sockets", async () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const syncServer = new SyncServer(serverStore);
    wsServer = new WebSocketSyncServer(syncServer, { port: PORT });
    await wsServer.start();

    const storeA = new FeatureStore({ now: () => 2, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 3, newId: () => "b1" });
    const mk = (store: FeatureStore) =>
      new SyncClient({
        store,
        connect: () => new NodeWebSocketConnection(new WebSocket(`ws://localhost:${PORT}`)),
        setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimer: (h) => clearTimeout(h as unknown as NodeJS.Timeout),
        random: () => 0.5,
      });
    const clientA = mk(storeA);
    const clientB = mk(storeB);
    clients.push(clientA, clientB);
    clientA.start();
    clientB.start();

    // Let both handshakes complete.
    await waitFor(() => syncServer.sessionCount === 2);

    // A creates a feature; it should reach B via the server relay.
    storeA.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [7, 7] },
      label: "a-to-b",
      color: "",
    });

    await waitFor(() => storeB.getRaw("a1")?.properties.label === "a-to-b");
    expect(storeB.getRaw("a1")?.properties.label).toBe("a-to-b");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/webSocketIntegration.test.ts`
Expected: PASS — 2 tests. This is the milestone: sync over a real socket. If it hangs or fails, likely causes: the `isOpen()`-gated start not firing on `onOpen` (the client never starts), the digest sent before open (lost), or the port in use. Investigate the adapter/client, do NOT weaken the test. If the fixed PORT is occupied in the environment, change it to another high port and note it.

- [ ] **Step 3: Run typecheck + full suite**

Run: `npm test && npm run typecheck`
Expected: all green; typecheck exits 0. Report count.

- [ ] **Step 4: Commit**

```bash
git add tests/webSocketIntegration.test.ts
git commit -m "test: prove sync converges over a real WebSocket"
```

---

## Task 8: Public exports & full suite green

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the new public surface to `src/index.ts`**

Append (keep all existing exports):
```typescript
export { BrowserWebSocketConnection } from "./browserWebSocketConnection.js";
export { NodeWebSocketConnection } from "./nodeWebSocketConnection.js";
export {
  WebSocketSyncServer,
  type WebSocketSyncServerOptions,
} from "./webSocketSyncServer.js";
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL tests pass across every file; `tsc --noEmit` exits 0 with no duplicate-export error. Report the actual total test count.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export WebSocket adapter public surface"
```

---

## Self-Review

**Spec coverage** (against `2026-06-18-websocket-adapters-design.md`):
- `isOpen()` on `Connection` + `MemoryEndpoint` → Task 1. ✅
- SyncClient `isOpen()`-gated start (immediate only if open, else onOpen) → Task 2. ✅
- Flapping-reset (reset attempt on first inbound, not bare open) → Task 2. ✅
- Test-factory `.open()` churn (syncClient/syncServer/syncMultiPeer) → Task 2. ✅
- `ws` + `@types/ws` deps → Task 3. ✅
- `BrowserWebSocketConnection` (dependency-free, minimal local WS type, send-drops-when-not-OPEN, isOpen, onMessage/onOpen/onClose, close) → Task 4. ✅
- `NodeWebSocketConnection` (ws socket, Buffer→string, error-as-close, send-drops, isOpen, close) → Task 5. ✅
- `WebSocketSyncServer` (ws.Server listen, per-socket accept, start/stop) → Task 6. ✅
- Real-localhost-socket integration: one client converges with server; two clients converge via relay → Task 7. ✅
- Exports → Task 8. ✅
- Out of scope (per spec): TLS/wss, auth, keepalive, server reconnect, compression — none implemented. ✅

**Placeholder scan:** No TBD/TODO in steps; every code step has complete code; every command has expected output. (The SyncClient code REMOVES the old TODO comments — Task 2 replaces the whole method.) ✅

**Type consistency:**
- `isOpen(): boolean` — defined Task 1, used by SyncClient Task 2 and both adapters Tasks 4–5. ✅
- `Connection` (send/onMessage/onOpen/onClose/isOpen/close) — both adapters implement the full set. ✅
- `BrowserWebSocketConnection(url, factory?)` — ctor with optional test factory, consistent in Task 4 impl + test. ✅
- `NodeWebSocketConnection(ws)` — ctor wraps a ws socket, consistent in Task 5 impl/test, Task 6 server, Task 7 integration. ✅
- `WebSocketSyncServer(syncServer, { port })` + `start()/stop()` Promises — Task 6, used in Task 7. ✅
- `SyncClient` deps (store/connect/setTimer/clearTimer/random) — unchanged from Plan B; Task 7 supplies real `setTimeout`/`clearTimeout`/`Math.random`-free `random: () => 0.5`. ✅

**Note on a deliberate choice:** Task 6 (`WebSocketSyncServer`) has no isolated unit test — it is exercised only by the real-socket integration test in Task 7. A fake-`ws.Server` unit test would assert almost nothing of value (the whole point is the real listen/accept/connection path); the integration test is the honest verification. Flagged so a reviewer does not treat the missing unit test as a gap.

**Note on async tests:** Task 7's integration tests are async (real sockets), using a `waitFor` poll helper and an `afterEach` that stops clients and the server. This is the first suite that isn't synchronous — the poll/cleanup discipline prevents port leaks and hung sockets between tests.
