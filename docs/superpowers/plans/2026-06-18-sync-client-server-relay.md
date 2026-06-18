# SyncClient + SyncServer (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete real-time sync — a SyncClient that auto-reconnects with capped-backoff jitter, and a SyncServer that relays edits among many clients through one shared store — reusing the Plan A SyncSession per connection.

**Architecture:** SyncSession gains an additive public `relay(features)` and an optional `onInbound` callback (fired after applying inbound deltas). SyncClient builds a fresh session per connection via an injected connection factory, wiring onOpen→start and reconnecting on close with capped exponential backoff + injected jitter. SyncServer holds one shared store and a set of sessions; `accept(conn)` registers a session whose `onInbound` relays to all other sessions (attributed, so never echoes to the origin). All timing/randomness/transport is injected — fully headless-testable.

**Tech Stack:** TypeScript, Vitest, Node 24. Builds on `@sartools/feature-store` (FeatureStore, SyncSession, Connection/connectionPair, TimerHandle, SarFeature).

**Spec:** `docs/superpowers/specs/2026-06-18-syncclient-server-relay-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/syncSession.ts` (modify) | Optional `onInbound` ctor opt; public `relay(features)`; call `onInbound` after applyDelta in `handle` |
| `src/syncClient.ts` (new) | Connection-factory + injected timer/jitter; fresh session per connection; capped-backoff reconnect |
| `src/syncServer.ts` (new) | Shared store + session set; `accept`/relay/remove |
| `src/index.ts` (modify) | Export `SyncClient`, `SyncServer`, dep types |
| `tests/syncSession.test.ts` (modify) | `relay()` and `onInbound` tests |
| `tests/syncClient.test.ts` (new) | connect/handshake, reconnect+backoff, stop, offline-edit-caught |
| `tests/syncServer.test.ts` (new) | accept/handshake, relay A→B, no echo, remove, late-join |
| `tests/syncMultiPeer.test.ts` (new) | Two clients + one server converge |

---

## Task 1: SyncSession — `relay()` and `onInbound`

**Files:**
- Modify: `src/syncSession.ts`
- Test: `tests/syncSession.test.ts`

- [ ] **Step 1: Append the failing tests to `tests/syncSession.test.ts`**

Reuse the existing top-level `A`/`B` constants and the imports (SyncSession, connectionPair, FeatureStore). Append:

```typescript
describe("SyncSession relay and onInbound", () => {
  it("relay() pushes an upsert to the peer even for features not in this store", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    // No start()/handshake — just test relay() in isolation.
    new SyncSession(storeB, connB); // B applies what it receives
    const sessionA = new SyncSession(storeA, connA);

    const feature = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [9, 9] as [number, number] },
      properties: {
        id: "relayed",
        author: "X",
        authorDeviceId: "dev-x",
        createdAt: 5,
        updatedAt: 5,
        deleted: false,
        kind: "marker" as const,
        label: "via-relay",
        color: "",
      },
    };
    sessionA.relay([feature]);
    expect(storeB.getRaw("relayed")?.properties.label).toBe("via-relay");
  });

  it("relay() is a no-op on empty features", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    let bGot = 0;
    connB.onMessage(() => bGot++);
    const sessionA = new SyncSession(storeA, connA);
    sessionA.relay([]);
    expect(bGot).toBe(0);
  });

  it("a stopped session relays nothing", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    let bGot = 0;
    connB.onMessage(() => bGot++);
    const sessionA = new SyncSession(storeA, connA);
    sessionA.stop();
    const feature = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [9, 9] as [number, number] },
      properties: {
        id: "x",
        author: "X",
        authorDeviceId: "dev-x",
        createdAt: 5,
        updatedAt: 5,
        deleted: false,
        kind: "marker" as const,
        label: "",
        color: "",
      },
    };
    sessionA.relay([feature]);
    expect(bGot).toBe(0);
  });

  it("fires onInbound after applying an inbound upsert", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const inbound: string[][] = [];
    const sessionA = new SyncSession(storeA, connA, {
      onInbound: (features) => inbound.push(features.map((f) => f.properties.id)),
    });
    void sessionA;
    // Peer B sends an upsert directly.
    connB.send(
      JSON.stringify({
        type: "upsert",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [1, 2] },
            properties: {
              id: "in1",
              author: "B",
              authorDeviceId: "dev-b",
              createdAt: 3,
              updatedAt: 3,
              deleted: false,
              kind: "marker",
              label: "",
              color: "",
            },
          },
        ],
      }),
    );
    expect(storeA.getRaw("in1")).toBeDefined();
    expect(inbound).toEqual([["in1"]]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/syncSession.test.ts`
Expected: FAIL — `sessionA.relay is not a function`, and `onInbound` not invoked.

- [ ] **Step 3: Modify `src/syncSession.ts`**

Add a `SarFeature` import to the existing type import line:
```typescript
import type { FeatureStore, ChangeOrigin } from "./featureStore.js";
import type { SarFeature } from "./types.js";
import type { Connection } from "./connection.js";
import { parseMessage, idsNeeded, type SyncMessage } from "./syncProtocol.js";
```

Add an options interface above the class:
```typescript
export interface SyncSessionOptions {
  /** Called after an inbound features/upsert is applied (server uses this to relay). */
  onInbound?: (features: SarFeature[]) => void;
}
```

Update the constructor to accept and store the option:
```typescript
  private onInbound?: (features: SarFeature[]) => void;

  constructor(
    private store: FeatureStore,
    private conn: Connection,
    opts: SyncSessionOptions = {},
  ) {
    this.onInbound = opts.onInbound;
    this.conn.onMessage((data) => this.handle(data));
    this.offChange = this.store.onChange((ids, origin) =>
      this.onLocalChange(ids, origin),
    );
  }
```

Add the public `relay` method (place it after `start()`):
```typescript
  /**
   * Push features to the peer as an upsert WITHOUT the local-only onChange gate.
   * Used by the server to forward remote-origin deltas to other clients. No-op if
   * stopped or empty.
   */
  relay(features: readonly SarFeature[]): void {
    if (this.stopped || features.length === 0) return;
    this.send({ type: "upsert", features: [...features] });
  }
```

In `handle()`, call `onInbound` after applying the delta for BOTH `features` and `upsert` cases. Change:
```typescript
      case "features": {
        this.store.applyDelta(msg.features);
        break;
      }
      case "upsert": {
        this.store.applyDelta(msg.features);
        break;
      }
```
to:
```typescript
      case "features": {
        this.store.applyDelta(msg.features);
        this.onInbound?.(msg.features);
        break;
      }
      case "upsert": {
        this.store.applyDelta(msg.features);
        this.onInbound?.(msg.features);
        break;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/syncSession.test.ts`
Expected: PASS — all SyncSession tests pass (existing + 4 new).

- [ ] **Step 5: Run the full suite (ensure no regression to Plan A) + typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL pass; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/syncSession.ts tests/syncSession.test.ts
git commit -m "feat: add SyncSession relay() and onInbound callback"
```

---

## Task 2: SyncServer — accept, relay, remove

**Files:**
- Create: `src/syncServer.ts`
- Test: `tests/syncServer.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/syncServer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SyncServer } from "../src/syncServer.js";
import { FeatureStore } from "../src/featureStore.js";
import { connectionPair } from "../src/connection.js";
import { SyncSession } from "../src/syncSession.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };
const C2 = { callsign: "Team2", deviceId: "dev-2" };

/** Build a client store + session wired to one end of a pair; server.accept the other. */
function connectClient(server: SyncServer, clientStore: FeatureStore) {
  const [clientConn, serverConn] = connectionPair();
  server.accept(serverConn);
  const session = new SyncSession(clientStore, clientConn);
  // Drive both handshakes: client starts, server session starts on its own accept.
  session.start();
  return { clientConn, session };
}

describe("SyncServer", () => {
  it("relays an edit from one client to another but not back to the origin", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);

    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    connectClient(server, storeA);
    connectClient(server, storeB);

    // A creates a feature live; it should reach B (via server relay) and the server.
    const f = storeA.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "from-a",
      color: "",
    });
    expect(serverStore.getRaw(f.properties.id)?.properties.label).toBe("from-a");
    expect(storeB.getRaw(f.properties.id)?.properties.label).toBe("from-a");
  });

  it("late-joining client catches up existing state on connect", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);

    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    connectClient(server, storeA);
    storeA.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "early",
      color: "",
    });

    // Now a late client B joins — it should receive "early" via handshake.
    const storeB = new FeatureStore({ now: () => 2, newId: () => "b1" });
    connectClient(server, storeB);
    expect(storeB.getRaw("a1")?.properties.label).toBe("early");
  });

  it("removes a session when its connection closes", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const { clientConn } = connectClient(server, storeA);
    expect(server.sessionCount).toBe(1);
    clientConn.close();
    expect(server.sessionCount).toBe(0);
  });

  it("a removed client no longer receives relays", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    const a = connectClient(server, storeA);
    connectClient(server, storeB);

    a.clientConn.close(); // A leaves
    expect(server.sessionCount).toBe(1);

    // B creates; A is gone so storeA must not receive it (and no crash).
    storeB.create(C2, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [7, 7] },
      label: "after-a-left",
      color: "",
    });
    expect(storeA.list().some((x) => x.properties.label === "after-a-left")).toBe(false);
    expect(storeB.getRaw("b1")?.properties.label).toBe("after-a-left");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncServer.test.ts`
Expected: FAIL — cannot find module `../src/syncServer.js`.

- [ ] **Step 3: Write the implementation** at `src/syncServer.ts`:

```typescript
import type { FeatureStore } from "./featureStore.js";
import type { Connection } from "./connection.js";
import type { SarFeature } from "./types.js";
import { SyncSession } from "./syncSession.js";

/**
 * Relays edits among many connected clients through one shared FeatureStore.
 * Each accepted connection gets a SyncSession; an inbound delta on one session is
 * relayed to all OTHER sessions (attributed, so it never echoes to its origin).
 * Transport-agnostic: feed it Connections via accept(). Real WebSocket listening
 * is a thin out-of-scope adapter.
 */
export class SyncServer {
  private sessions = new Set<SyncSession>();

  constructor(private store: FeatureStore) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Intake a new client connection: register a session and wire its lifecycle. */
  accept(conn: Connection): void {
    const session = new SyncSession(this.store, conn, {
      onInbound: (features) => this.relayFrom(session, features),
    });
    this.sessions.add(session);

    conn.onOpen(() => session.start());
    conn.onClose(() => {
      session.stop();
      this.sessions.delete(session);
    });

    // If the connection is already open (in-memory pairs deliver synchronously),
    // start immediately so the handshake runs.
    session.start();
  }

  /** Forward an applied inbound delta to every session except its origin. */
  private relayFrom(origin: SyncSession, features: SarFeature[]): void {
    for (const session of this.sessions) {
      if (session !== origin) session.relay(features);
    }
  }
}
```

Note on `accept` calling `session.start()` directly AND on `onOpen`: the in-memory `connectionPair` does not auto-fire `onOpen` (the test never calls `conn.open()`), so `accept` starts the handshake immediately. For a real WebSocket the `onOpen` wiring covers the async-open case. Calling `start()` twice is harmless (sends a second digest that reconciles to a no-op), but to avoid the double-digest, guard with a flag.

Add a guard so `start()` runs at most once per session. Update the implementation: replace the two `session.start()` triggers with a guarded helper:

```typescript
  accept(conn: Connection): void {
    const session = new SyncSession(this.store, conn, {
      onInbound: (features) => this.relayFrom(session, features),
    });
    this.sessions.add(session);

    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      session.start();
    };

    conn.onOpen(startOnce);
    conn.onClose(() => {
      session.stop();
      this.sessions.delete(session);
    });

    // In-memory pairs don't auto-fire onOpen; start now. The onOpen wiring covers
    // real async-opening transports (startOnce makes it idempotent).
    startOnce();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncServer.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/syncServer.ts tests/syncServer.test.ts
git commit -m "feat: add SyncServer with attributed relay"
```

---

## Task 3: SyncClient — connect & handshake

**Files:**
- Create: `src/syncClient.ts`
- Test: `tests/syncClient.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/syncClient.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SyncClient } from "../src/syncClient.js";
import { FeatureStore } from "../src/featureStore.js";
import { connectionPair } from "../src/connection.js";
import { SyncSession } from "../src/syncSession.js";
import type { InMemoryConnection } from "../src/connection.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };

/** A fake timer that captures the latest scheduled callback so tests can fire it. */
class FakeTimer {
  private fns = new Map<number, () => void>();
  private next = 1;
  lastDelay = 0;
  setTimer = (fn: () => void, ms: number): number => {
    this.lastDelay = ms;
    const h = this.next++;
    this.fns.set(h, fn);
    return h;
  };
  clearTimer = (h: number): void => {
    this.fns.delete(h);
  };
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
  get armed(): number {
    return this.fns.size;
  }
}

describe("SyncClient connect", () => {
  it("connects and converges with a peer via handshake", () => {
    // The "server side" of the connection is a plain SyncSession over a store
    // that already has a feature; the client should pull it.
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv-1" });
    serverStore.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "on-server",
      color: "",
    });

    const timer = new FakeTimer();
    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });

    // connect() factory: build a pair, attach a server-side session to one end,
    // return the other end to the client.
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      const serverSession = new SyncSession(serverStore, serverConn);
      // server session must exist before client starts; start it now.
      serverSession.start();
      return clientConn;
    };

    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 0.5,
    });
    client.start();

    expect(clientStore.getRaw("srv-1")?.properties.label).toBe("on-server");
    client.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncClient.test.ts`
Expected: FAIL — cannot find module `../src/syncClient.js`.

- [ ] **Step 3: Write the implementation** at `src/syncClient.ts`:

```typescript
import type { FeatureStore } from "./featureStore.js";
import type { Connection } from "./connection.js";
import { SyncSession } from "./syncSession.js";

export type TimerHandle = number;

export interface SyncClientDeps {
  store: FeatureStore;
  /** Factory that creates a fresh Connection for each (re)connect attempt. */
  connect: () => Connection;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  /** Jitter source in [0, 1). */
  random: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Maintains a sync connection to a peer with auto-reconnect. Builds a fresh
 * SyncSession per connection. On disconnect, reconnects with capped exponential
 * backoff + jitter (all timing/randomness injected for deterministic tests).
 */
export class SyncClient {
  private readonly store: FeatureStore;
  private readonly connect: () => Connection;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  private conn: Connection | null = null;
  private session: SyncSession | null = null;
  private attempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private intentionalStop = false;

  constructor(deps: SyncClientDeps) {
    this.store = deps.store;
    this.connect = deps.connect;
    this.setTimer = deps.setTimer;
    this.clearTimer = deps.clearTimer;
    this.random = deps.random;
    this.baseDelayMs = deps.baseDelayMs ?? 1000;
    this.maxDelayMs = deps.maxDelayMs ?? 30000;
  }

  start(): void {
    this.intentionalStop = false;
    this.connectNow();
  }

  stop(): void {
    this.intentionalStop = true;
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.session?.stop();
    this.conn?.close();
    this.session = null;
    this.conn = null;
  }

  private connectNow(): void {
    const conn = this.connect();
    this.conn = conn;
    const session = new SyncSession(this.store, conn);
    this.session = session;

    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      this.attempt = 0; // reset backoff on a successful open
      session.start();
    };

    conn.onOpen(startOnce);
    conn.onClose(() => this.onDisconnect());

    // In-memory pairs don't auto-fire onOpen; start now. onOpen covers async opens.
    startOnce();
  }

  private onDisconnect(): void {
    this.session?.stop();
    this.session = null;
    this.conn = null;
    if (this.intentionalStop) return;
    const delay = this.nextDelay();
    this.attempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connectNow();
    }, delay);
  }

  private nextDelay(): number {
    const capped = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempt);
    // Half-jitter: 50–100% of the capped delay.
    return capped * (0.5 + 0.5 * this.random());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncClient.test.ts`
Expected: PASS — 1 test passes.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/syncClient.ts tests/syncClient.test.ts
git commit -m "feat: add SyncClient connect and handshake"
```

---

## Task 4: SyncClient — reconnect, backoff, stop

**Files:**
- Test: `tests/syncClient.test.ts`

The reconnect logic was written in Task 3; this task adds the tests that pin backoff timing, the stop() behavior, and the offline-edit-caught-on-reconnect property. If a test fails, fix the source.

- [ ] **Step 1: Append the failing/verifying tests to `tests/syncClient.test.ts`**

```typescript
describe("SyncClient reconnect", () => {
  it("reconnects after a disconnect with the expected jittered delay", () => {
    const timer = new FakeTimer();
    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });
    let conns = 0;
    const made: InMemoryConnection[] = [];
    const connect = (): InMemoryConnection => {
      conns++;
      const [clientConn, serverConn] = connectionPair();
      void serverConn;
      made.push(clientConn);
      return clientConn;
    };
    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 0, // half-jitter floor: delay = capped * 0.5
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });
    client.start();
    expect(conns).toBe(1);

    // First disconnect: attempt was 0 → capped 1000 → *0.5 = 500.
    made[0]!.close();
    expect(timer.lastDelay).toBe(500);
    expect(timer.armed).toBe(1);

    // Fire the reconnect timer → second connection.
    timer.fire();
    expect(conns).toBe(2);

    // Second disconnect: attempt is now 1 → capped 2000 → *0.5 = 1000.
    made[1]!.close();
    expect(timer.lastDelay).toBe(1000);
    client.stop();
  });

  it("caps the backoff delay at maxDelayMs", () => {
    const timer = new FakeTimer();
    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });
    const made: InMemoryConnection[] = [];
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      void serverConn;
      made.push(clientConn);
      return clientConn;
    };
    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 1, // half-jitter ceiling: delay = capped * 1.0
      baseDelayMs: 1000,
      maxDelayMs: 4000,
    });
    client.start();
    // Drop repeatedly; capped doublings: 1000,2000,4000,4000(capped)...
    made[0]!.close();
    expect(timer.lastDelay).toBe(1000);
    timer.fire();
    made[1]!.close();
    expect(timer.lastDelay).toBe(2000);
    timer.fire();
    made[2]!.close();
    expect(timer.lastDelay).toBe(4000);
    timer.fire();
    made[3]!.close();
    expect(timer.lastDelay).toBe(4000); // capped
    client.stop();
  });

  it("stop() cancels a pending reconnect and does not reconnect", () => {
    const timer = new FakeTimer();
    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });
    let conns = 0;
    const made: InMemoryConnection[] = [];
    const connect = (): InMemoryConnection => {
      conns++;
      const [clientConn, serverConn] = connectionPair();
      void serverConn;
      made.push(clientConn);
      return clientConn;
    };
    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 0.5,
    });
    client.start();
    made[0]!.close(); // schedules a reconnect
    expect(timer.armed).toBe(1);
    client.stop(); // must cancel it
    expect(timer.armed).toBe(0);
    timer.fire(); // nothing armed; no new connection
    expect(conns).toBe(1);
  });

  it("an edit made while disconnected propagates after reconnect (no outbound queue needed)", () => {
    const timer = new FakeTimer();
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const clientStore = new FeatureStore({ now: () => 5, newId: () => "c1" });
    let serverConnRef: InMemoryConnection | null = null;
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      serverConnRef = serverConn;
      new SyncSession(serverStore, serverConn).start();
      return clientConn;
    };
    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 0.5,
    });
    client.start();
    // Disconnect.
    serverConnRef!.close();
    // While "offline", the client edits locally.
    const f = clientStore.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [3, 3] },
      label: "offline-edit",
      color: "",
    });
    // Reconnect — the fresh handshake must carry the offline edit to the server.
    timer.fire();
    expect(serverStore.getRaw(f.properties.id)?.properties.label).toBe("offline-edit");
    client.stop();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/syncClient.test.ts`
Expected: PASS — all SyncClient tests pass. If the backoff-delay assertions fail, the `nextDelay`/`attempt` logic in `syncClient.ts` needs fixing (e.g. attempt incremented at the wrong time); fix the source, not the test.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add tests/syncClient.test.ts
git commit -m "test: pin SyncClient backoff, stop, and offline-edit catch-up"
```

---

## Task 5: Multi-peer integration proof

**Files:**
- Test: `tests/syncMultiPeer.test.ts`

The capstone: two SyncClients through one SyncServer all converge to identical `toGeoJSON()`.

- [ ] **Step 1: Write the test** at `tests/syncMultiPeer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SyncClient } from "../src/syncClient.js";
import { SyncServer } from "../src/syncServer.js";
import { FeatureStore } from "../src/featureStore.js";
import { connectionPair } from "../src/connection.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

/** A no-op timer (we don't exercise reconnect here) and fixed jitter. */
function noopTimerDeps() {
  return {
    setTimer: (_fn: () => void, _ms: number) => 0,
    clearTimer: (_h: number) => {},
    random: () => 0.5,
  };
}

describe("multi-peer convergence", () => {
  it("two clients through one server converge to identical state", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const server = new SyncServer(serverStore);

    let tA = 10;
    let tB = 10;
    let nA = 0;
    let nB = 0;
    const storeA = new FeatureStore({ now: () => tA, newId: () => `a-${++nA}` });
    const storeB = new FeatureStore({ now: () => tB, newId: () => `b-${++nB}` });

    // connect() factories that route each client into the server.
    const connectA = () => {
      const [clientConn, serverConn] = connectionPair();
      server.accept(serverConn);
      return clientConn;
    };
    const connectB = () => {
      const [clientConn, serverConn] = connectionPair();
      server.accept(serverConn);
      return clientConn;
    };

    const clientA = new SyncClient({ store: storeA, connect: connectA, ...noopTimerDeps() });
    const clientB = new SyncClient({ store: storeB, connect: connectB, ...noopTimerDeps() });
    clientA.start();
    clientB.start();

    // Interleaved edits on both clients.
    tA = 20;
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "a-one",
      color: "",
    });
    tB = 21;
    storeB.create(B, {
      kind: "line",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      label: "b-one",
      color: "",
    });
    tA = 30;
    const aTwo = storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [2, 2] },
      label: "a-two",
      color: "",
    });
    tA = 31;
    storeA.remove(A, aTwo.properties.id);

    // All three stores converge.
    expect(storeA.toGeoJSON()).toEqual(storeB.toGeoJSON());
    expect(storeA.toGeoJSON()).toEqual(serverStore.toGeoJSON());
    expect(storeA.list()).toHaveLength(2); // a-one, b-one (a-two deleted)

    clientA.stop();
    clientB.stop();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/syncMultiPeer.test.ts`
Expected: PASS — 1 test. If stores do NOT converge, it points to a real relay/handshake gap — investigate server relay or client handshake; do not weaken the test.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add tests/syncMultiPeer.test.ts
git commit -m "test: prove two-client-through-server convergence"
```

---

## Task 6: Public exports & full suite green

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the new public surface to `src/index.ts`**

Append (keep all existing exports):
```typescript
export { SyncServer } from "./syncServer.js";
export { SyncClient, type SyncClientDeps } from "./syncClient.js";
export { type SyncSessionOptions } from "./syncSession.js";
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL tests pass across every file; `tsc --noEmit` exits 0 with no duplicate-export error. Report the actual total test count.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export SyncClient and SyncServer public surface"
```

---

## Self-Review

**Spec coverage** (against `2026-06-18-syncclient-server-relay-design.md`):
- SyncSession additions: optional `onInbound` ctor opt, public `relay(features)` (stopped/empty guards), `onInbound` fired after applyDelta → Task 1. ✅
- SyncServer: `accept(conn)` builds a session with relay wired, onOpen→start, onClose→remove; `relayFrom` excludes origin; `sessionCount` → Task 2. ✅
- Relay flow (A→B, not back to A), late-join catch-up, remove on close → Task 2 tests. ✅
- SyncClient: injected store/connect/timer/random, fresh session per connection, onOpen→start, reset attempt on open → Task 3. ✅
- Reconnect: capped exponential backoff (`min(max, base*2^attempt)`) + half-jitter (`*(0.5+0.5*random())`), stop() cancels pending + no reconnect, offline-edit caught on reconnect (no queue) → Tasks 3–4. ✅
- Multi-peer convergence (2 clients + server → identical toGeoJSON) → Task 5. ✅
- Exports → Task 6. ✅
- Out of scope (per spec): real WebSocket bindings, auth, presence, rate limiting, persistence wiring — none implemented. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✅

**Type consistency:**
- `SyncSessionOptions { onInbound?: (features: SarFeature[]) => void }` — defined Task 1, consumed by SyncServer Task 2, exported Task 6. ✅
- `relay(features: readonly SarFeature[])` — Task 1; called by SyncServer `relayFrom` Task 2. ✅
- `SyncClientDeps { store, connect, setTimer, clearTimer, random, baseDelayMs?, maxDelayMs? }` — Task 3; used in Tasks 3–5 tests. ✅
- `TimerHandle = number` — defined in syncClient.ts Task 3 (matches the existing writeScheduler TimerHandle shape). ✅
- `SyncServer(store)`, `accept(conn)`, `sessionCount` — Task 2; used in Tasks 2, 5. ✅
- Backoff formula identical in implementation (Task 3 `nextDelay`) and test assertions (Task 4): `min(max, base*2^attempt) * (0.5 + 0.5*random())`. With `random()=0` → `*0.5`; with `random()=1` → `*1.0`. Task 4's delay assertions (500, 1000; and 1000/2000/4000 capped) match. ✅

**Note on a deliberate design choice:** Both `SyncServer.accept` and `SyncClient.connectNow` call `session.start()` immediately (guarded by a `started`/`startOnce` flag) AND wire `onOpen`. This is because the in-memory `connectionPair` does not auto-fire `onOpen` — the immediate start drives the synchronous test handshake, while the `onOpen` wiring covers real async-opening WebSocket transports. The `startOnce` guard makes the double-trigger idempotent (no double digest). Noted so a reviewer does not flag the dual trigger as a bug.
