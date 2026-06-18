# SyncClient + SyncServer (Plan B — real-time relay) — Design

**Date:** 2026-06-18
**Status:** Approved design, ready for implementation planning
**Builds on:** `2026-06-18-syncclient-server-design.md` (Plan A: origin seam, syncProtocol, Connection, SyncSession)

## Overview

Plan B completes the real-time sync story: a `SyncClient` that maintains a
connection to a peer with auto-reconnect, and a `SyncServer` that relays edits
among many connected clients through one shared store. Both reuse the proven
Plan A `SyncSession` per connection; the server adds an explicit, attributed
relay (distinct from the local-only `onChange` broadcast, which deliberately
suppresses remote-origin changes to prevent loops).

## Goals

- `SyncClient`: connect, handshake, broadcast/apply live edits, and auto-reconnect
  with capped exponential backoff + jitter over flaky links.
- `SyncServer`: accept many client connections, merge all into one shared store,
  and relay each client's edits to the other clients.
- No echo loops: relay is attributed (never sent back to its origin); remote-origin
  changes stay terminal on the `onChange` path.
- No outbound queue: the digest handshake on (re)connect rediscovers everything
  diverged offline; local editing is never blocked.
- Late-joining clients catch up the whole operation's state on connect.
- Fully testable headless via in-memory `connectionPair()` + injected timer/jitter
  — no real WebSocket.

## Non-Goals (v1 scope cuts — YAGNI)

- Real WebSocket bindings (client connection factory, server listener) — thin
  adapters implementing `Connection`, deferred to a final integration step.
- Auth / handshake tokens.
- Presence / live cursor sharing.
- Per-client rate limiting or message-size caps.
- Server-side persistence wiring (the caller may attach the server's store to
  `IndexedDbPersistence` — composition, not new code here).

## Architecture

```
   ┌──────── Client ────────┐                  ┌─────────────── SyncServer ───────────────┐
   │ SyncClient             │                  │  FeatureStore (one, shared)               │
   │  • connect() factory   │                  │                                           │
   │  • injected timer      │   accept(conn)   │  accept(conn):                            │
   │  • injected jitter     │ ───────────────► │   new SyncSession(store, conn, {onInbound})│
   │  on connect:           │                  │   wire onOpen→start, onClose→remove        │
   │   new SyncSession ──────┼──── wire ───────┤   register in sessions set                 │
   │   onOpen→start          │                 │                                           │
   │  on close:             │                  │  onInbound(features, fromSession):        │
   │   session.stop()        │                 │   for every OTHER session: s.relay(features)│
   │   backoff + reconnect   │                 │                                           │
   └─────────────────────────┘                 └────────────────────────────────────────────┘
```

Both treat real WebSocket bindings (client factory, server listener) as thin,
out-of-scope adapters. Both build a fresh `SyncSession` per connection — matching
Plan A's non-idempotent `start()` and terminal `stop()`.

## SyncSession Additions (surgical, additive)

Two minimal backward-compatible additions to the proven Plan A unit:

```typescript
// Constructor gains an optional opts arg — existing callers unaffected.
constructor(
  store: FeatureStore,
  conn: Connection,
  opts?: { onInbound?: (features: SarFeature[]) => void },
)

// Push features to the peer WITHOUT the local-only onChange gate.
relay(features: readonly SarFeature[]): void
```

- **`relay(features)`** — sends `{ type: "upsert", features }` directly via the
  private `send`. This is how the server pushes a remote-origin delta onward (the
  `onChange` broadcast suppresses `"remote"` by design). Guarded by the `stopped`
  flag (a stopped session relays nothing). No-op on empty.
- **`onInbound` callback** — in `handle()`, after `applyDelta(msg.features)` for
  both the `features` and `upsert` cases, call `this.onInbound?.(msg.features)`.
  Fires after the merge (store already updated). A leaf client omits it; the
  server supplies one that relays to siblings.

**Safety:** the echo-suppression invariant is untouched — `onChange` still
broadcasts only `"local"`. `onInbound` is a separate server-only fan-out path,
and the server excludes the originating session (it holds the reference), so a
delta never bounces back to its sender. Remote-origin changes remain terminal on
the `onChange` path; relay is an explicit, attributed forward. These additions are
additive — all existing Plan A tests stay green.

## SyncClient

```typescript
interface SyncClientDeps {
  store: FeatureStore;
  connect: () => Connection;          // factory: makes a fresh Connection
  setTimer: (fn: () => void, ms: number) => TimerHandle; // injected
  clearTimer: (h: TimerHandle) => void;
  random: () => number;               // injected jitter source [0,1)
  baseDelayMs?: number;               // default 1000
  maxDelayMs?: number;                // default 30000
}

class SyncClient {
  start(): void; // begin: connect now
  stop(): void;  // stop reconnecting; tear down current session + connection
}
```

**Lifecycle:**
- `start()` → `connectNow()`: call `connect()` for a Connection, build a fresh
  `SyncSession(store, conn)` (no `onInbound` — a leaf client does not relay), wire
  `conn.onOpen → session.start()` and `conn.onClose → onDisconnect()`. Reset the
  backoff attempt counter on a successful open.
- `onDisconnect()` → `session.stop()`; if not intentionally stopped, schedule a
  reconnect via the injected timer after `delay(attempt)`, incrementing the
  attempt counter.
- `delay(attempt)` = `min(maxDelayMs, baseDelayMs * 2 ** attempt)`, then apply
  jitter: `delay * (0.5 + 0.5 * random())` — 50–100% of the capped delay (keeps a
  sane floor while spreading reconnects). Deterministic under an injected `random`.
- `stop()` → set an `intentional` flag (so `onClose` won't reconnect),
  `session.stop()`, `conn.close()`, cancel any pending reconnect timer.

**No outbound queue:** on reconnect the fresh session's digest handshake
rediscovers everything diverged while offline. Local editing is never blocked (the
store is always live; missed live-upserts are caught by the next handshake).

## SyncServer

```typescript
class SyncServer {
  constructor(store: FeatureStore);
  accept(conn: Connection): void; // intake a new client connection
  get sessionCount(): number;     // for tests/inspection
}
```

**`accept(conn)`:**
1. Build `SyncSession(store, conn, { onInbound })` where `onInbound(features)`
   relays those features to every other registered session:
   `for (const s of sessions) if (s !== thisSession) s.relay(features)`.
2. Wire `conn.onOpen → session.start()` and `conn.onClose → remove()`.
3. Register the session in the `sessions` set.

**`remove()` (on close):** `session.stop()`, delete it from the set. (The
connection fired its own close; no `conn.close()` needed.)

**Relay flow:** client A sends an `upsert` → A's server-session `handle()` applies
it to the shared store → fires `onInbound(features)` → server relays to B's and
C's sessions via `relay()` → B and C `applyDelta` (origin `"remote"`, terminal —
no rebroadcast). No loop: relay is attributed (excludes A) and remote-origin
changes never re-fan via `onChange`.

**Handshake on accept:** a new client and the server both run the digest
handshake, so a late-joining client converges with the shared store (which already
holds everyone's features) — full catch-up on connect.

**Idempotency backstop:** even if a feature reaches a session twice, LWW makes the
re-merge a no-op (proven in the core). Relay cannot storm.

## File Structure

| File | Responsibility |
|---|---|
| `src/syncSession.ts` (modify) | Optional `onInbound` ctor opt; public `relay(features)`; call `onInbound` after applyDelta in `handle` |
| `src/syncClient.ts` (new) | Connection-factory + injected timer/jitter; fresh session per connection; capped-backoff reconnect |
| `src/syncServer.ts` (new) | Shared store + session set; `accept`/relay/remove |
| `src/index.ts` (modify) | Export `SyncClient`, `SyncServer`, dep types |
| `tests/syncSession.test.ts` (modify) | `relay()` and `onInbound` tests |
| `tests/syncClient.test.ts` (new) | connect→handshake; reconnect+backoff with injected timer/jitter; stop() halts reconnect; offline edit caught on reconnect |
| `tests/syncServer.test.ts` (new) | accept→handshake; relay A→B; no echo to A; remove on close; late-join catch-up |
| `tests/syncMultiPeer.test.ts` (new) | Two clients + one server converge to identical toGeoJSON |

## Error Handling

- **`connect()` throws / connection never opens** — treated like a disconnect:
  schedule a backoff reconnect. The client never gives up (capped retries
  forever); local editing continues.
- **Relay to a closed/stopped sibling** — `relay()` is `stopped`-guarded and
  `send` swallows on a closed connection (Plan A behavior); a dead sibling silently
  no-ops, removed on its own `onClose`.
- **`accept` of an already-closed connection** — `onClose` fires, `remove()` cleans
  it up; the handshake simply never completes. No crash.
- **Reconnect storm** — jitter spreads reconnects; backoff caps the rate.

## Testing Strategy

All headless via `connectionPair()` + injected timer/jitter.

- **SyncSession:** `relay()` pushes an upsert even for remote-origin features;
  `onInbound` fires after applyDelta with the merged features; a stopped session
  relays nothing.
- **SyncClient:** connects and handshakes; on close reconnects after the expected
  jittered delay (assert exact delay via stubbed timer + random); backoff doubles
  and caps; `stop()` cancels a pending reconnect and does not reconnect; an edit
  made while disconnected propagates after reconnect (proves no queue needed).
- **SyncServer:** accept two clients — an edit on A reaches B but not back to A; a
  late-joining C catches up existing state on connect; `onClose` removes the
  session (`sessionCount` drops).
- **Multi-peer integration:** two `SyncClient`s through one `SyncServer`, each
  creates/edits/deletes, all three stores (two clients + server) converge to
  identical `toGeoJSON()` — the capstone proof, analog of the two-session
  convergence.
