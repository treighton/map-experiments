# IndexedDB Persistence Layer — Design

**Date:** 2026-06-18
**Status:** Approved design, ready for implementation planning
**Builds on:** `2026-06-17-collaborative-sar-mapping-design.md` (FeatureStore core)

## Overview

Persist the FeatureStore's features to IndexedDB so a client survives page reloads
and offline restarts. The store stays a pure, synchronous, in-memory CRDT; a
separate adapter listens for changes and writes them. This also introduces the
`onChange` notification seam that the future SyncClient will reuse to broadcast
live edits.

## Goals

- Features (including tombstones) survive page reload / offline restart.
- The `FeatureStore` remains pure and synchronous with no IndexedDB dependency.
- Incremental, per-feature writes proportional to what actually changed.
- Debounced batching so bursty edits (e.g. dragging a polygon vertex) collapse
  into single writes — important for battery and flash wear on field devices.
- Hydrate at boot by reusing the existing CRDT merge path (`applyDelta`), so
  loading from disk and merging from sync are the same operation.
- Fully testable in the existing Node-based Vitest setup (no real browser).

## Non-Goals (v1 scope cuts — YAGNI)

- Schema migrations beyond v1 (single object store; no version-2 upgrade path yet).
- Encryption at rest.
- Quota-pressure eviction (surface the error; do not evict).
- Cross-tab synchronization (`BroadcastChannel`); two tabs on one device is a
  later concern.
- Tombstone compaction / garbage collection of old deletes.

## Architecture

```
   create/update/remove/applyDelta
            │ (each mutation)
            ▼
   ┌─────────────────┐   onChange(ids)   ┌──────────────────┐   debounced flush   ┌────────────┐
   │  FeatureStore   │ ────────────────► │ IndexedDbPersist │ ──────────────────► │ IndexedDB  │
   │  (pure, sync)   │                   │   (adapter)      │  putAll(features)   │ "features" │
   └─────────────────┘                   └──────────────────┘                     └────────────┘
            ▲                                     │
            │           load() at boot           │
            └─────────────applyDelta─────────────┘
```

The store gains one new capability — change notification — and otherwise stays
exactly as built. It has zero IndexedDB dependency; it only announces what
changed. Three units with clean boundaries:

- **`FeatureStore.onChange`** — the notification seam (small addition).
- **`WriteScheduler`** — pure debounce/dirty-set batching, injected timer, no
  IndexedDB. Independently unit-testable.
- **`IndexedDbPersistence`** — binds store + scheduler + IndexedDB; the only unit
  that touches IndexedDB. Tested with `fake-indexeddb`.

## The `onChange` seam on FeatureStore

```typescript
type ChangeListener = (changedIds: readonly string[]) => void;

onChange(listener: ChangeListener): () => void; // returns an unsubscribe fn
```

**Semantics:**
- After each mutation completes, the store calls every listener once with the ids
  that changed:
  - `create` → `[newId]`
  - `update` / `remove` → `[id]`
  - `applyDelta(incoming)` → the ids present in the incoming delta (we notify for
    delta ids, not the whole store; persisting a no-op record when LWW kept the
    local version is harmless).
- Listeners fire **after** the internal `features` map is updated, so a listener
  reading `getRaw(id)` sees the new state.
- Notification is **synchronous** within the mutation call. The map is already
  updated before notify, so a throwing listener cannot leave the mutation
  half-applied. Notification is wrapped per-listener so one bad listener does not
  break others; failures are logged.
- `onChange` returns an unsubscribe function.

**Why ids, not full features:** the listener fetches the current record via
`store.getRaw(id)` when it is ready to write (post-debounce), so it persists the
latest merged state rather than a stale snapshot captured at notify time. During a
debounce window a feature may change several times; it is written once, with its
final value.

This adds observation, not I/O — the store's purity is intact.

## WriteScheduler (pure debounce/dirty-set)

```typescript
interface SchedulerDeps {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  flushFn: (ids: readonly string[]) => void | Promise<void>;
  delayMs?: number; // default 200
  maxBatch?: number; // default 500
}

class WriteScheduler {
  markDirty(id: string): void; // add id, (re)arm the debounce timer
  flush(): void; // cancel timer, flush current dirty set now
  get pending(): number; // dirty count (for tests/inspection)
}
```

**Behavior:**
- `markDirty(id)` adds the id to a `Set` and arms a timer for `delayMs`. Each new
  `markDirty` **resets** the timer (trailing debounce) — a burst collapses into
  one flush.
- If the dirty set reaches `maxBatch`, flush **immediately** so a large import
  does not balloon a single transaction or delay persistence indefinitely.
- On flush: snapshot the dirty set, clear it, cancel any pending timer, and call
  `flushFn(ids)`. `markDirty` calls during an in-flight async flush accumulate
  into the next batch (no lost edits).
- `flush()` is the explicit "write now" escape hatch (page unload, pre-sync,
  tests).

Timer injection (`setTimer`/`clearTimer`) lets tests drive time manually — no
`setTimeout` flakiness — mirroring the `now`/`newId` injection in `FeatureStore`.
Production wiring passes real `setTimeout`/`clearTimeout`.

## IndexedDbPersistence (the binding)

```typescript
class IndexedDbPersistence {
  static async open(dbName: string, deps?): Promise<IndexedDbPersistence>;
  async load(store: FeatureStore): Promise<void>; // hydrate
  attach(store: FeatureStore): () => void; // subscribe + persist on change
  async flush(): Promise<void>; // force pending writes
  async close(): Promise<void>;
}
```

**Schema:** one database, one object store `"features"`, `keyPath: "properties.id"`.
Each record is a whole `SarFeature`, tombstones included. Created in the IndexedDB
`onupgradeneeded` handler.

**`load(store)`** — read all records via `getAll()`, then `store.applyDelta(records)`.
Reuses the CRDT merge path, so disk state merges idempotently with whatever is
already in memory. Tombstones flow in naturally.

**`attach(store)`** — `store.onChange((ids) => ids.forEach(markDirty))`, with the
scheduler's `flushFn` wired to write. Returns an unsubscribe that also detaches.
**Order matters:** call `load()` *before* `attach()` so hydration does not echo
every loaded feature straight back into a write (`load` uses `applyDelta`, which
notifies; attach only afterward).

**`flushFn(ids)`** — for each id, `store.getRaw(id)` to get the *current* record,
then `put` them all in **one** `readwrite` transaction. Fetching at flush time
(not notify time) guarantees the latest merged value is persisted. A `getRaw`
returning `undefined` is skipped.

**Errors:** a failed write transaction is logged and its ids are **re-marked
dirty** for retry on the next flush, so a transient IndexedDB error does not
silently drop data. `open`/`load` failures reject so the caller can fall back to
in-memory-only and warn.

## File Structure

| File | Responsibility |
|---|---|
| `src/featureStore.ts` (modify) | Add `ChangeListener` type, private listener set, `onChange()`, and `notify()` calls in create/update/remove/applyDelta |
| `src/writeScheduler.ts` (new) | Pure debounce/dirty-set batching; injected timer |
| `src/indexedDbPersistence.ts` (new) | IndexedDB binding: open/load/attach/flush/close |
| `src/index.ts` (modify) | Export the new public surface |
| `tests/featureStore.test.ts` (modify) | onChange notification tests |
| `tests/writeScheduler.test.ts` (new) | Debounce/batch/flush with a fake timer |
| `tests/indexedDbPersistence.test.ts` (new) | load/attach/flush round-trips via `fake-indexeddb` |
| `package.json` (modify) | Add `fake-indexeddb` devDependency |

## Error Handling

- **Throwing change-listener** — wrapped per-listener; one bad listener does not
  break others or the mutation; logged.
- **IndexedDB write failure** — dirty ids re-marked for retry; logged; not
  silently dropped.
- **`open`/`load` failure** — promise rejects; caller can fall back to in-memory
  editing (which still works) and surface a warning.
- **Hydration vs. live-edit race** — `load()` before `attach()` prevents an
  echo-write storm.

## Testing Strategy

- **WriteScheduler (pure):** burst collapses to one flush; timer resets on each
  `markDirty`; `maxBatch` forces immediate flush; explicit `flush()` cancels timer
  and writes; edits during an in-flight flush land in the next batch.
- **onChange:** each mutation notifies with correct ids; unsubscribe stops
  notifications; throwing listener is isolated.
- **IndexedDbPersistence (`fake-indexeddb`):** create→flush→reopen→load
  round-trips a feature; a tombstone survives reload; load-then-edit persists the
  edit; `attach` after `load` does not echo; write-failure path re-marks dirty.
- **Integration:** store + persistence + `fake-indexeddb` — create/edit/delete,
  `flush`, reopen a fresh store, `load`, assert `toGeoJSON()` matches (the
  persistence analog of the convergence test).
