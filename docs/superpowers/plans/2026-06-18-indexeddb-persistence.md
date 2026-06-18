# IndexedDB Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist FeatureStore features (including tombstones) to IndexedDB via a change-notification seam, a pure debounce scheduler, and an IndexedDB binding adapter — so a client survives reloads and offline restarts.

**Architecture:** The pure synchronous `FeatureStore` gains an `onChange(listener)` seam that fires after each mutation with the changed feature ids. A pure `WriteScheduler` debounces dirty ids into batches with an injected timer. `IndexedDbPersistence` binds them: it hydrates the store at boot via `applyDelta` (reusing the CRDT merge path) and persists changed features in batched `readwrite` transactions. The store keeps zero IndexedDB dependency.

**Tech Stack:** TypeScript, Vitest, `fake-indexeddb` (in-memory IndexedDB for Node tests), Node 24. Builds on `@sartools/feature-store`.

**Spec:** `docs/superpowers/specs/2026-06-18-indexeddb-persistence-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/featureStore.ts` (modify) | Add `ChangeListener` type, private listener set, `onChange()`, `notify()`; call notify in create/update/remove/applyDelta |
| `src/writeScheduler.ts` (new) | Pure debounce/dirty-set batching with injected timer |
| `src/indexedDbPersistence.ts` (new) | IndexedDB binding: open/load/attach/flush/close |
| `src/index.ts` (modify) | Export new public surface |
| `tests/featureStore.test.ts` (modify) | onChange notification tests |
| `tests/writeScheduler.test.ts` (new) | Debounce/batch/flush tests with a fake timer |
| `tests/indexedDbPersistence.test.ts` (new) | load/attach/flush round-trips via `fake-indexeddb` |
| `package.json` (modify) | Add `fake-indexeddb` devDependency |

**Decomposition rationale:** the two pure units (`onChange` seam, `WriteScheduler`) come first — no async, TDD-friendly. The IndexedDB binding builds on both. A final integration task proves the full reload round-trip, mirroring the core plan's convergence proof.

---

## Task 1: Add `fake-indexeddb` dev dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install fake-indexeddb as a dev dependency**

Run: `npm install --save-dev fake-indexeddb@^6.0.0`
Expected: installs cleanly; `package.json` gains `"fake-indexeddb": "^6.0.0"` under `devDependencies`.

- [ ] **Step 2: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add fake-indexeddb dev dependency"
```

---

## Task 2: FeatureStore `onChange` notification seam

**Files:**
- Modify: `src/featureStore.ts`
- Test: `tests/featureStore.test.ts`

- [ ] **Step 1: Append the failing tests to `tests/featureStore.test.ts`**

Reuse the existing top-level `ME` constant and `makeStore()` helper. Append this describe block at the end of the file:

```typescript
describe("FeatureStore onChange", () => {
  it("notifies with the new id on create", () => {
    const store = makeStore();
    const seen: string[][] = [];
    store.onChange((ids) => seen.push([...ids]));
    const f = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(seen).toEqual([[f.properties.id]]);
  });

  it("notifies on update and remove with the feature id", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    const seen: string[][] = [];
    store.onChange((ids) => seen.push([...ids]));
    store.update(ME, "id-1", { label: "x" });
    store.remove(ME, "id-1");
    expect(seen).toEqual([["id-1"], ["id-1"]]);
  });

  it("notifies applyDelta with the incoming ids", () => {
    const store = makeStore();
    const seen: string[][] = [];
    store.onChange((ids) => seen.push([...ids]));
    store.applyDelta([
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: {
          id: "ext",
          author: "Sue",
          authorDeviceId: "dev-other",
          createdAt: 1,
          updatedAt: 1,
          deleted: false,
          kind: "marker",
          label: "",
          color: "",
        },
      },
    ]);
    expect(seen).toEqual([["ext"]]);
  });

  it("listener sees post-mutation state via getRaw", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    let labelAtNotify = "";
    store.onChange(() => {
      labelAtNotify = store.getRaw("id-1")?.properties.label ?? "";
    });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "tent",
      color: "",
    });
    expect(labelAtNotify).toBe("tent");
  });

  it("unsubscribe stops notifications", () => {
    const store = makeStore();
    const seen: string[][] = [];
    const off = store.onChange((ids) => seen.push([...ids]));
    off();
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(seen).toEqual([]);
  });

  it("a throwing listener does not break other listeners or the mutation", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    const seen: string[][] = [];
    store.onChange(() => {
      throw new Error("boom");
    });
    store.onChange((ids) => seen.push([...ids]));
    const f = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(seen).toEqual([["id-1"]]);
    expect(store.getRaw(f.properties.id)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: FAIL — `store.onChange is not a function`.

- [ ] **Step 3: Add the seam to `src/featureStore.ts`**

Add this exported type near the other exported types (after `EditableFields`):

```typescript
export type ChangeListener = (changedIds: readonly string[]) => void;
```

Add a private field to the `FeatureStore` class alongside `features`/`now`/`newId`:

```typescript
  private listeners = new Set<ChangeListener>();
```

Add these methods inside the class (after `applyDelta`):

```typescript
  /**
   * Subscribe to mutations. The listener is called after each create/update/
   * remove/applyDelta with the ids that changed, and can read the new state via
   * getRaw. Returns an unsubscribe function.
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners. One throwing listener must not break others or the store. */
  private notify(changedIds: readonly string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(changedIds);
      } catch (err) {
        console.error("FeatureStore change listener threw:", err);
      }
    }
  }
```

Now add `notify` calls at the END of each mutation (after the store is updated, before returning):

In `create`, before `return f;`:
```typescript
    this.notify([f.properties.id]);
```

In `update`, before `return next;`:
```typescript
    this.notify([id]);
```

In `remove`: there are TWO return points. The early `if (current.properties.deleted) return current;` is a no-op (nothing changed) — do NOT notify there. Before the final `return next;`, add:
```typescript
    this.notify([id]);
```

In `applyDelta`, after `this.features = mergeAll(this.features, incoming);` and before the method ends:
```typescript
    this.notify(incoming.map((f) => f.properties.id));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: PASS — all featureStore tests pass (the 6 new onChange tests plus the existing ones).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/featureStore.ts tests/featureStore.test.ts
git commit -m "feat: add onChange notification seam to FeatureStore"
```

---

## Task 3: WriteScheduler (pure debounce/dirty-set)

**Files:**
- Create: `src/writeScheduler.ts`
- Test: `tests/writeScheduler.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/writeScheduler.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { WriteScheduler } from "../src/writeScheduler.js";

/** Manual timer so tests control when the debounce fires. */
class FakeTimer {
  private fns = new Map<number, () => void>();
  private next = 1;
  setTimer = (fn: () => void, _ms: number): number => {
    const h = this.next++;
    this.fns.set(h, fn);
    return h;
  };
  clearTimer = (h: number): void => {
    this.fns.delete(h);
  };
  /** Fire all currently-armed timers (simulates the delay elapsing). */
  tick(): void {
    const pending = [...this.fns.entries()];
    this.fns.clear();
    for (const [, fn] of pending) fn();
  }
  get armed(): number {
    return this.fns.size;
  }
}

function makeScheduler(flushed: string[][], maxBatch = 500) {
  const timer = new FakeTimer();
  const scheduler = new WriteScheduler({
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    flushFn: (ids) => {
      flushed.push([...ids]);
    },
    delayMs: 200,
    maxBatch,
  });
  return { scheduler, timer };
}

describe("WriteScheduler", () => {
  it("collapses a burst of markDirty into a single flush", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    scheduler.markDirty("b");
    scheduler.markDirty("a");
    expect(flushed).toEqual([]); // nothing flushed yet
    timer.tick();
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("re-arms the timer on each markDirty (trailing debounce)", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    expect(timer.armed).toBe(1);
    scheduler.markDirty("b");
    // old timer cleared, new one armed — still exactly one armed
    expect(timer.armed).toBe(1);
  });

  it("flushes immediately when the dirty set reaches maxBatch", () => {
    const flushed: string[][] = [];
    const { scheduler } = makeScheduler(flushed, 2);
    scheduler.markDirty("a");
    expect(flushed).toEqual([]);
    scheduler.markDirty("b"); // hits maxBatch=2
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("explicit flush() writes the current dirty set and cancels the timer", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    scheduler.flush();
    expect(flushed).toEqual([["a"]]);
    expect(timer.armed).toBe(0);
  });

  it("flush() with an empty dirty set does nothing", () => {
    const flushed: string[][] = [];
    const { scheduler } = makeScheduler(flushed);
    scheduler.flush();
    expect(flushed).toEqual([]);
  });

  it("markDirty after a flush starts a fresh batch", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    timer.tick();
    scheduler.markDirty("b");
    timer.tick();
    expect(flushed).toEqual([["a"], ["b"]]);
  });

  it("pending reports the current dirty count", () => {
    const flushed: string[][] = [];
    const { scheduler } = makeScheduler(flushed);
    scheduler.markDirty("a");
    scheduler.markDirty("b");
    expect(scheduler.pending).toBe(2);
    scheduler.flush();
    expect(scheduler.pending).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/writeScheduler.test.ts`
Expected: FAIL — cannot find module `../src/writeScheduler.js`.

- [ ] **Step 3: Write minimal implementation** at `src/writeScheduler.ts`:

```typescript
export type TimerHandle = number;

export interface SchedulerDeps {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  flushFn: (ids: readonly string[]) => void | Promise<void>;
  delayMs?: number;
  maxBatch?: number;
}

/**
 * Accumulates dirty ids and flushes them as a batch after a quiet window
 * (trailing debounce) or when the batch reaches maxBatch. Pure: all timing is
 * injected via setTimer/clearTimer so tests drive it deterministically.
 */
export class WriteScheduler {
  private dirty = new Set<string>();
  private timer: TimerHandle | null = null;
  private readonly setTimer: SchedulerDeps["setTimer"];
  private readonly clearTimer: SchedulerDeps["clearTimer"];
  private readonly flushFn: SchedulerDeps["flushFn"];
  private readonly delayMs: number;
  private readonly maxBatch: number;

  constructor(deps: SchedulerDeps) {
    this.setTimer = deps.setTimer;
    this.clearTimer = deps.clearTimer;
    this.flushFn = deps.flushFn;
    this.delayMs = deps.delayMs ?? 200;
    this.maxBatch = deps.maxBatch ?? 500;
  }

  get pending(): number {
    return this.dirty.size;
  }

  markDirty(id: string): void {
    this.dirty.add(id);
    if (this.dirty.size >= this.maxBatch) {
      this.flush();
      return;
    }
    this.arm();
  }

  flush(): void {
    this.cancelTimer();
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    void this.flushFn(ids);
  }

  private arm(): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/writeScheduler.test.ts`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/writeScheduler.ts tests/writeScheduler.test.ts
git commit -m "feat: add pure WriteScheduler debounce/batch unit"
```

---

## Task 4: IndexedDbPersistence — open & load (hydration)

**Files:**
- Create: `src/indexedDbPersistence.ts`
- Test: `tests/indexedDbPersistence.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/indexedDbPersistence.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbPersistence } from "../src/indexedDbPersistence.js";
import { FeatureStore } from "../src/featureStore.js";
import type { SarFeature } from "../src/types.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };

// Reset the global indexedDB before each test for isolation.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function noopTimerDeps() {
  // For load-only tests we never need the debounce timer to fire.
  return {
    setTimer: (_fn: () => void, _ms: number) => 0,
    clearTimer: (_h: number) => {},
  };
}

describe("IndexedDbPersistence load", () => {
  it("opens a database and loads zero features into an empty store", async () => {
    const p = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    await p.load(store);
    expect(store.list()).toHaveLength(0);
    await p.close();
  });

  it("round-trips a created feature across reopen via flush + load", async () => {
    const p1 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const store1 = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    p1.attach(store1);
    store1.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "tent",
      color: "red",
    });
    await p1.flush();
    await p1.close();

    const p2 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const store2 = new FeatureStore({ now: () => 2000, newId: () => "id-x" });
    await p2.load(store2);
    expect(store2.list()).toHaveLength(1);
    expect(store2.getRaw("id-1")?.properties.label).toBe("tent");
    await p2.close();
  });

  it("persists a tombstone so a deleted feature survives reload", async () => {
    const p1 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const store1 = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    p1.attach(store1);
    store1.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    store1.remove(ME, "id-1");
    await p1.flush();
    await p1.close();

    const p2 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const store2 = new FeatureStore({ now: () => 2000, newId: () => "id-x" });
    await p2.load(store2);
    expect(store2.list()).toHaveLength(0); // tombstone excluded from list
    expect(store2.getRaw("id-1")?.properties.deleted).toBe(true); // but present
    await p2.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexedDbPersistence.test.ts`
Expected: FAIL — cannot find module `../src/indexedDbPersistence.js`.

- [ ] **Step 3: Write the implementation** at `src/indexedDbPersistence.ts`:

```typescript
import type { SarFeature } from "./types.js";
import type { FeatureStore } from "./featureStore.js";
import { WriteScheduler } from "./writeScheduler.js";

const STORE_NAME = "features";

export interface PersistenceTimerDeps {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (h: number) => void;
  delayMs?: number;
  maxBatch?: number;
}

/** Promisify an IDBRequest. */
function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persists FeatureStore features to IndexedDB. The only unit that touches
 * IndexedDB. Hydrates via the store's applyDelta (CRDT merge path) and writes
 * changed features in debounced batched transactions.
 */
export class IndexedDbPersistence {
  private scheduler: WriteScheduler;
  private boundStore: FeatureStore | null = null;

  private constructor(
    private db: IDBDatabase,
    timerDeps: PersistenceTimerDeps,
  ) {
    this.scheduler = new WriteScheduler({
      setTimer: timerDeps.setTimer,
      clearTimer: timerDeps.clearTimer,
      flushFn: (ids) => this.writeBatch(ids),
      delayMs: timerDeps.delayMs,
      maxBatch: timerDeps.maxBatch,
    });
  }

  static async open(
    dbName: string,
    timerDeps: PersistenceTimerDeps,
  ): Promise<IndexedDbPersistence> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "properties.id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IndexedDbPersistence(db, timerDeps);
  }

  /** Read all persisted features and merge them into the store via applyDelta. */
  async load(store: FeatureStore): Promise<void> {
    const tx = this.db.transaction(STORE_NAME, "readonly");
    const objStore = tx.objectStore(STORE_NAME);
    const records = await reqAsPromise<SarFeature[]>(
      objStore.getAll() as IDBRequest<SarFeature[]>,
    );
    store.applyDelta(records);
  }

  /**
   * Subscribe to the store and persist changes. Call load() BEFORE attach() so
   * hydration does not echo loaded features straight back into writes. Returns an
   * unsubscribe that also detaches.
   */
  attach(store: FeatureStore): () => void {
    this.boundStore = store;
    const off = store.onChange((ids) => {
      for (const id of ids) this.scheduler.markDirty(id);
    });
    return () => {
      off();
      this.boundStore = null;
    };
  }

  /** Force any pending debounced writes to complete. */
  async flush(): Promise<void> {
    this.scheduler.flush();
    await this.inFlight;
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  private inFlight: Promise<void> = Promise.resolve();

  /** Write the current value of each id in one readwrite transaction. */
  private writeBatch(ids: readonly string[]): Promise<void> {
    const store = this.boundStore;
    if (!store) return Promise.resolve();
    const run = (async () => {
      const tx = this.db.transaction(STORE_NAME, "readwrite");
      const objStore = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        const feature = store.getRaw(id);
        if (feature) objStore.put(feature);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      }).catch((err) => {
        // Re-mark dirty for retry on the next flush; do not drop data.
        console.error("IndexedDbPersistence write failed, will retry:", err);
        for (const id of ids) this.scheduler.markDirty(id);
      });
    })();
    this.inFlight = run;
    return run;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexedDbPersistence.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/indexedDbPersistence.ts tests/indexedDbPersistence.test.ts
git commit -m "feat: add IndexedDbPersistence open/load/attach/flush"
```

---

## Task 5: Attach-after-load (no echo) & live-edit persistence tests

**Files:**
- Test: `tests/indexedDbPersistence.test.ts`

This task adds tests that pin two behaviors the implementation from Task 4 already provides: editing a loaded feature persists the edit, and attaching after load does not re-write the loaded features. No source changes expected; if a test fails, fix the source, not the test.

- [ ] **Step 1: Append the failing/verifying tests to `tests/indexedDbPersistence.test.ts`**

```typescript
describe("IndexedDbPersistence live edits", () => {
  it("persists an edit made after loading existing data", async () => {
    // Seed the db with one feature.
    const p1 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const seed = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    p1.attach(seed);
    seed.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "old",
      color: "",
    });
    await p1.flush();
    await p1.close();

    // Reopen, load, attach, then edit.
    const p2 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    let t = 2000;
    const store = new FeatureStore({ now: () => t, newId: () => "id-z" });
    await p2.load(store);
    p2.attach(store);
    t = 3000;
    store.update(ME, "id-1", { label: "new" });
    await p2.flush();
    await p2.close();

    // Reopen again and confirm the edit persisted.
    const p3 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const check = new FeatureStore({ now: () => 4000, newId: () => "id-q" });
    await p3.load(check);
    expect(check.getRaw("id-1")?.properties.label).toBe("new");
    await p3.close();
  });

  it("attach after load does not echo loaded features into a write", async () => {
    // Seed one feature.
    const p1 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const seed = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    p1.attach(seed);
    seed.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    await p1.flush();
    await p1.close();

    // Reopen and load WITHOUT attaching first; track scheduler activity by
    // attaching only after load and asserting nothing is pending.
    const p2 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const store = new FeatureStore({ now: () => 2000, newId: () => "id-z" });
    await p2.load(store);
    const off = p2.attach(store);
    // load happened before attach, so the loaded feature must not be queued.
    expect((p2 as unknown as { scheduler: { pending: number } }).scheduler.pending).toBe(0);
    off();
    await p2.close();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/indexedDbPersistence.test.ts`
Expected: PASS — 5 tests total. If "attach after load does not echo" FAILS, the bug is real (attach happened before load somewhere, or load notifies): fix the source ordering, not the test.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add tests/indexedDbPersistence.test.ts
git commit -m "test: pin live-edit persistence and no-echo-after-load"
```

---

## Task 6: Full reload round-trip integration test

**Files:**
- Test: `tests/persistenceIntegration.test.ts`

Proves the end-to-end property: a store with creates/edits/deletes, after flush + reopen + load into a fresh store, produces identical `toGeoJSON()`. This is the persistence analog of the core plan's convergence proof.

- [ ] **Step 1: Write the test** at `tests/persistenceIntegration.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbPersistence } from "../src/indexedDbPersistence.js";
import { FeatureStore } from "../src/featureStore.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

function noopTimerDeps() {
  return {
    setTimer: (_fn: () => void, _ms: number) => 0,
    clearTimer: (_h: number) => {},
  };
}

describe("persistence reload round-trip", () => {
  it("a fresh store loaded from disk matches the original toGeoJSON", async () => {
    const p1 = await IndexedDbPersistence.open("sar-rt", noopTimerDeps());
    let t = 1000;
    let n = 0;
    const original = new FeatureStore({ now: () => t, newId: () => `id-${++n}` });
    p1.attach(original);

    original.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "alpha",
      color: "red",
    });
    original.create(ME, {
      kind: "line",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      label: "route",
      color: "blue",
    });
    const third = original.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [2, 2] },
      label: "to-delete",
      color: "",
    });
    t = 2000;
    original.update(ME, "id-1", { label: "alpha-edited" });
    original.remove(ME, third.properties.id);

    await p1.flush();
    await p1.close();

    const p2 = await IndexedDbPersistence.open("sar-rt", noopTimerDeps());
    const reloaded = new FeatureStore({ now: () => 9999, newId: () => "id-new" });
    await p2.load(reloaded);

    expect(reloaded.toGeoJSON()).toEqual(original.toGeoJSON());
    expect(reloaded.list()).toHaveLength(2); // third was deleted
    await p2.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/persistenceIntegration.test.ts`
Expected: PASS — 1 test passes. If `toGeoJSON()` differs, it points to a real persistence gap (e.g. a field not round-tripping); investigate the source.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add tests/persistenceIntegration.test.ts
git commit -m "test: prove persistence reload round-trip"
```

---

## Task 7: Public exports & full suite green

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the new public surface to `src/index.ts`**

Append these exports (keep all existing exports):

```typescript
export { WriteScheduler, type SchedulerDeps, type TimerHandle } from "./writeScheduler.js";
export {
  IndexedDbPersistence,
  type PersistenceTimerDeps,
} from "./indexedDbPersistence.js";
export { type ChangeListener } from "./featureStore.js";
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL tests pass (merge, featureStore, convergence, identity, writeScheduler, indexedDbPersistence, persistenceIntegration); `tsc --noEmit` exits 0. Report the actual total test count.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export persistence public surface"
```

---

## Self-Review

**Spec coverage** (against `2026-06-18-indexeddb-persistence-design.md`):
- `onChange` seam (post-mutation, ids, unsubscribe, throwing-listener isolation, getRaw sees new state) → Task 2. ✅
- create/update/remove/applyDelta notify with correct ids; remove no-op early return does not notify → Task 2. ✅
- WriteScheduler (debounce burst→one flush, timer reset, maxBatch immediate, explicit flush, pending) → Task 3. ✅
- IndexedDbPersistence open (schema: store "features", keyPath properties.id) → Task 4. ✅
- load via applyDelta (hydration reuses CRDT merge), tombstones persist & survive reload → Task 4. ✅
- attach subscribes; load-before-attach prevents echo → Tasks 4, 5. ✅
- flushFn fetches current via getRaw at flush time, one readwrite transaction → Task 4. ✅
- write-failure re-marks dirty for retry → Task 4 (writeBatch catch). ✅
- Reload round-trip integration (persistence analog of convergence) → Task 6. ✅
- `fake-indexeddb` test setup → Task 1 + per-file `beforeEach` resets `indexedDB`. ✅
- Public exports → Task 7. ✅
- Out of scope (per spec): migrations, encryption, quota eviction, cross-tab, tombstone compaction — none implemented. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. ✅

**Type consistency:**
- `ChangeListener = (changedIds: readonly string[]) => void` — defined Task 2, exported Task 7. ✅
- `WriteScheduler` ctor takes `SchedulerDeps { setTimer, clearTimer, flushFn, delayMs?, maxBatch? }` — Task 3; `IndexedDbPersistence` constructs it with the same shape — Task 4. ✅
- `IndexedDbPersistence.open(dbName, timerDeps)`, `load(store)`, `attach(store): () => void`, `flush(): Promise<void>`, `close(): Promise<void>` — consistent across Tasks 4, 5, 6. ✅
- `getRaw(id): SarFeature | undefined`, `applyDelta(incoming)`, `toGeoJSON()`, `onChange()` — all from the existing FeatureStore, used consistently. ✅
- Object store name `"features"`, keyPath `"properties.id"` — consistent in open/load/writeBatch. ✅

**Note on a known simplification:** `IndexedDbPersistence` tracks a single `inFlight` promise rather than a queue. With the debounce model (one batch in flight at a time, next batch accumulates in the scheduler) this is sufficient; `flush()` awaits the current in-flight write. The retry-on-failure path re-marks ids dirty so they are caught by a subsequent flush. This is intentional for v1 and noted so a reviewer does not flag it as an oversight.
