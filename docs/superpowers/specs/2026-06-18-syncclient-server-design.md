# SyncClient + Minimal Server (Real-Time Sync) — Design

**Date:** 2026-06-18
**Status:** Approved design, ready for implementation planning
**Builds on:** `2026-06-17-collaborative-sar-mapping-design.md` (FeatureStore core),
`2026-06-18-indexeddb-persistence-design.md` (persistence + onChange seam)

## Overview

Real-time collaborative sync over WebSocket for the SAR mapping tool. A
transport-agnostic `SyncClient` exchanges digests and deltas with a peer to
converge two `FeatureStore`s, and broadcasts live local edits. A minimal
`SyncServer` is a thin relay: one shared store, one protocol session per
connected client, forwarding merged deltas to the other clients. Client and
server run the identical protocol; the field-vs-cloud distinction is only what a
node connects upward to.

## Goals

- Two peers converge to identical state on (re)connect via a stateless digest
  reconcile (the protocol already proven by the core's convergence test).
- Live local edits propagate immediately while connected.
- Fully resilient to flaky links: local editing never blocks; auto-reconnect with
  backoff re-handshakes and catches up everything missed offline.
- One bad payload never corrupts the store (inbound validation boundary).
- No echo storms / infinite loops in the client↔field↔cloud tree topology.
- Client and server share one protocol implementation (cannot drift).
- Fully testable headless in Node via in-memory connection pairs — no real
  WebSocket needed for the core protocol.

## Non-Goals (v1 scope cuts — YAGNI)

- Real WebSocket bindings (browser `WebSocket`, Node `ws` listener) — thin
  adapters implementing `Connection`, deferred to a later integration step.
- Auth / handshake tokens.
- Compression / binary framing (JSON only).
- Version vectors (tree topology only; origin-tag + LWW idempotency suffice).
- Per-peer durable sync cursors / "since last sync" high-water marks.
- Presence / live cursor sharing.

## Architecture

```
   ┌─────────────── Client ───────────────┐         ┌────────── Server (field or cloud) ──────────┐
   │  FeatureStore                          │         │  FeatureStore (one, shared)                  │
   │     │ onChange(ids, origin)            │         │                                              │
   │     ▼                                  │         │   SyncSession ──┐                            │
   │  SyncClient ─ SyncSession ─ Connection │◄──────► │ Connection ─ SyncSession ─┼ relay to others  │
   │                (protocol)              │  wire   │              SyncSession ──┘                  │
   └────────────────────────────────────────┘         └──────────────────────────────────────────────┘
```

`SyncSession` is the shared heart — one per connection, owning the protocol for
that link: send/receive digest, compute `idsNeeded`, exchange `need`/`features`,
broadcast live `upsert`, and validate every inbound message before merging. It
talks to an injected `Connection` and a `FeatureStore`.

- **Client** = one `SyncClient` wrapping a single `SyncSession` against its
  upstream connection, plus auto-reconnect/backoff.
- **Server** = one `FeatureStore`, one `SyncSession` per connected client, plus a
  relay: a delta merged from session A is forwarded to all other sessions.

Both run the identical protocol. WebSocket bindings are thin adapters
implementing `Connection`, out of scope here (tests use in-memory pairs).

## Origin-Tagged Change Seam (FeatureStore change)

Extend the existing notification to carry origin:

```typescript
export type ChangeOrigin = "local" | "remote";
export type ChangeListener = (
  changedIds: readonly string[],
  origin: ChangeOrigin,
) => void;
```

- `create` / `update` / `remove` → `notify(ids, "local")`
- `applyDelta` → `notify(ids, "remote")`

The SyncSession subscribes and broadcasts only `"local"` changes. Remote-origin
changes (from `applyDelta`) are applied but never rebroadcast — which makes the
tree topology loop-free (remote changes are terminal at every node). The server's
relay is a separate, explicit forward path, not driven by `onChange`.

**Backward compatibility:** the existing `IndexedDbPersistence.attach` listener
ignores the new `origin` arg — it persists both local and remote changes
(correct: disk holds everything). One-line signature widening; body unchanged. The
existing `onChange` tests gain `origin` assertions.

## Wire Protocol & Validation

Tagged-union JSON over the `Connection` (which carries strings):

```typescript
type SyncMessage =
  | { type: "digest"; entries: Record<string, number> } // id → updatedAt, on connect
  | { type: "need"; ids: string[] }                      // request full features
  | { type: "features"; features: SarFeature[] }         // response to need, or relayed
  | { type: "upsert"; features: SarFeature[] };          // live local edit broadcast
```

**Inbound validation boundary** (resolves the deferred `parseFeature` seam):

- Pure `parseMessage(raw: string): SyncMessage | null` — `JSON.parse` in
  try/catch; validate `type` discriminant and shape.
- Pure `parseFeature(value: unknown): SarFeature | null` — validate required
  properties: `id` (non-empty string), `updatedAt` (finite number — guards
  against `NaN`/missing, which would poison `digest()`/LWW), `authorDeviceId`,
  `kind`, `deleted` (boolean), and geometry shape.
- `features`/`upsert` messages run every feature through `parseFeature`: invalid
  ones are dropped + logged, the rest still apply. A structurally malformed
  message is rejected wholesale + logged; the connection stays up. One bad payload
  never corrupts the store.

`parseFeature` lives in the core package (the server tier needs it too),
co-located with the CRDT.

## Reconcile Flow & Shared `idsNeeded`

**On connect (both sides symmetric):**
1. Each side sends `{ type: "digest", entries: store.digest() }`.
2. On receiving the peer's digest, compute `idsNeeded(localDigest, remoteDigest)`
   → ids the peer has newer/unknown → send `{ type: "need", ids }`.
3. On receiving `need`, reply `{ type: "features", features: store.featuresFor(ids) }`.
4. On receiving `features`, validate each, `store.applyDelta(valid)`. Converged.

`idsNeeded` is promoted from the convergence test into the core package as a
tested, exported pure function — shared by client and server so they cannot drift.

**Live mode (after handshake):** the SyncSession's `onChange((ids, origin))`
listener fires only for `"local"` → sends
`{ type: "upsert", features: store.featuresFor(ids) }`. The peer validates +
`applyDelta` (→ `"remote"`, terminal).

**Server relay:** when a session merges an inbound `upsert`/`features`, the server
forwards `{ type: "upsert", features }` to all other sessions. Those peers apply
as `"remote"` → no rebroadcast → no loop. LWW idempotency is the backstop: a
feature arriving twice merges to a no-op.

**Reconnect:** on `onClose`, `SyncClient` reconnects with capped exponential
backoff + jitter (injected timer). On reopen, the full digest handshake re-runs,
catching up everything missed offline. No outbound queue is needed — divergence is
rediscovered by the digest exchange.

## File Structure

| File | Responsibility |
|---|---|
| `src/featureStore.ts` (modify) | `ChangeOrigin` type; `onChange`/`notify` carry origin; create/update/remove→`"local"`, applyDelta→`"remote"` |
| `src/syncProtocol.ts` (new) | `SyncMessage` types, `parseMessage`, `parseFeature`, `idsNeeded` — all pure |
| `src/connection.ts` (new) | `Connection` interface + in-memory `connectionPair()` for tests |
| `src/syncSession.ts` (new) | Per-connection protocol: handshake, need/features, live upsert, inbound validation + merge |
| `src/syncClient.ts` (new) | Wraps one SyncSession + auto-reconnect/backoff (injected timer) |
| `src/syncServer.ts` (new) | One store + N sessions + relay to other sessions |
| `src/index.ts` (modify) | Export new public surface |
| `src/indexedDbPersistence.ts` (modify) | `attach` listener widened to ignore `origin` (one line) |
| `tests/syncProtocol.test.ts` (new) | parseMessage/parseFeature/idsNeeded |
| `tests/syncSession.test.ts` (new) | handshake convergence, live upsert, origin-only broadcast, invalid drop |
| `tests/syncClient.test.ts` (new) | reconnect + backoff + re-handshake catch-up |
| `tests/syncServer.test.ts` (new) | relay A→B, no rebroadcast loop, idempotent double-arrival |
| `tests/syncIntegration.test.ts` (new) | two clients + one server converge to identical toGeoJSON |

## Connection Interface

```typescript
export interface Connection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
```

An in-memory `connectionPair(): [Connection, Connection]` wires two endpoints so a
message `send` on one surfaces as `onMessage` on the other — used to drive
sessions deterministically in tests, the way `connectionPair` mirrors the
two-store convergence harness.

## Error Handling

- Malformed message → reject + log; connection stays up.
- Invalid feature in a batch → drop that one + log; apply the rest.
- `send` on a closed connection → swallow + log; reconnect handles recovery.
- Disconnect → local editing unaffected; reconnect re-handshakes.
- Listener exceptions → already isolated by the store's per-listener try/catch.

## Testing Strategy

All headless via in-memory `connectionPair()`; no real WebSocket.

- **`parseMessage`/`parseFeature`:** valid passes; bad JSON, wrong `type`,
  `NaN`/missing `updatedAt`, missing id → rejected.
- **`idsNeeded`:** disjoint, overlapping newer/older, unknown ids.
- **`SyncSession`:** two sessions over a connection pair complete the handshake and
  converge; live upsert propagates; only `"local"` broadcasts; invalid inbound
  dropped.
- **`SyncClient`:** reconnects after close with backoff (injected timer);
  re-handshake catches up edits made while disconnected; no outbound queue.
- **`SyncServer`:** relay — client A's edit reaches client B via the server;
  remote-origin not rebroadcast (no loop); a feature arriving twice is an
  idempotent no-op.
- **Integration:** two clients + one server, each creates/edits/deletes, all three
  stores converge to identical `toGeoJSON()` (the multi-peer analog of the
  convergence + persistence round-trip proofs).
