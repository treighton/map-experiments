# Sync Protocol + Session (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the transport-agnostic sync protocol foundation — origin-tagged change seam, pure protocol primitives (parseMessage/parseFeature/idsNeeded), an injectable Connection abstraction, and a SyncSession that converges two stores over a connection — ending with a two-session convergence proof.

**Architecture:** A `SyncSession` owns the per-connection protocol (digest handshake, need/features exchange, live upsert broadcast, inbound validation+merge) and talks to an injected `Connection` and a `FeatureStore`. The store's `onChange` seam is widened to tag each change `"local"` or `"remote"` so the session broadcasts only local edits (loop-free in a tree). All protocol logic is pure or driven through in-memory connection pairs — no real WebSocket.

**Tech Stack:** TypeScript, Vitest, Node 24. Builds on `@sartools/feature-store` (FeatureStore, applyDelta, digest, featuresFor, onChange).

**Spec:** `docs/superpowers/specs/2026-06-18-syncclient-server-design.md`

**Scope note:** This is Plan A of two. It covers the origin seam, `syncProtocol.ts`, `connection.ts`, and `syncSession.ts`, ending with a two-session convergence proof. Plan B (later) adds `SyncClient` (reconnect/backoff), `SyncServer` (relay), and multi-peer integration.

---

## File Structure (this plan)

| File | Responsibility |
|---|---|
| `src/featureStore.ts` (modify) | `ChangeOrigin` type; `onChange`/`notify` carry origin; create/update/remove→`"local"`, applyDelta→`"remote"` |
| `src/indexedDbPersistence.ts` (modify) | `attach` listener signature widened to ignore the new `origin` arg (one line) |
| `src/syncProtocol.ts` (new) | `SyncMessage` types, `parseMessage`, `parseFeature`, `idsNeeded` — all pure |
| `src/connection.ts` (new) | `Connection` interface + in-memory `connectionPair()` |
| `src/syncSession.ts` (new) | Per-connection protocol: handshake, need/features, live upsert, inbound validation + merge |
| `src/index.ts` (modify) | Export new public surface |
| Tests | `syncProtocol.test.ts`, `connection.test.ts`, `syncSession.test.ts`, `syncSessionConvergence.test.ts`, plus onChange origin assertions in `featureStore.test.ts` |

---

## Task 1: Origin-tagged change seam

**Files:**
- Modify: `src/featureStore.ts`
- Modify: `tests/featureStore.test.ts`

- [ ] **Step 1: Update the existing onChange tests to assert origin (in `tests/featureStore.test.ts`)**

Find the `describe("FeatureStore onChange", ...)` block. Update these existing tests to assert the origin argument. Replace the listener captures so they record `[ids, origin]` pairs.

Replace the test `"notifies with the new id on create"` body with:
```typescript
  it("notifies with the new id and local origin on create", () => {
    const store = makeStore();
    const seen: [string[], string][] = [];
    store.onChange((ids, origin) => seen.push([[...ids], origin]));
    const f = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(seen).toEqual([[[f.properties.id], "local"]]);
  });
```

Replace the test `"notifies applyDelta with the incoming ids"` body with:
```typescript
  it("notifies applyDelta with the incoming ids and remote origin", () => {
    const store = makeStore();
    const seen: [string[], string][] = [];
    store.onChange((ids, origin) => seen.push([[...ids], origin]));
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
    expect(seen).toEqual([[["ext"], "remote"]]);
  });
```

Add a new test right after it:
```typescript
  it("tags update and remove as local origin", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    const seen: string[] = [];
    store.onChange((_ids, origin) => seen.push(origin));
    store.update(ME, "id-1", { label: "x" });
    store.remove(ME, "id-1");
    expect(seen).toEqual(["local", "local"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: FAIL — the origin assertions fail (`origin` is currently `undefined`).

- [ ] **Step 3: Update the seam in `src/featureStore.ts`**

Add the `ChangeOrigin` type next to `ChangeListener` and update `ChangeListener`:
```typescript
export type ChangeOrigin = "local" | "remote";
export type ChangeListener = (
  changedIds: readonly string[],
  origin: ChangeOrigin,
) => void;
```

Update `notify` to take and forward an origin:
```typescript
  /** Notify listeners. One throwing listener must not break others or the store. */
  private notify(changedIds: readonly string[], origin: ChangeOrigin): void {
    for (const listener of this.listeners) {
      try {
        listener(changedIds, origin);
      } catch (err) {
        console.error("FeatureStore change listener threw:", err);
      }
    }
  }
```

Update each notify call site:
- `create`: `this.notify([f.properties.id], "local");`
- `update`: `this.notify([id], "local");`
- `remove` (final path only): `this.notify([id], "local");`
- `applyDelta`: `this.notify(incoming.map((f) => f.properties.id), "remote");`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: PASS — all featureStore tests pass.

- [ ] **Step 5: Run typecheck — expect a known break in persistence (fixed next task)**

Run: `npm run typecheck`
Expected: This MAY pass (the persistence listener `(ids) => ...` is assignable to the wider `(ids, origin) => ...` signature since extra params are allowed in TS). If it passes, good. If it reports an error in `indexedDbPersistence.ts`, that is expected and fixed in Task 2. Either way, proceed.

- [ ] **Step 6: Commit**

```bash
git add src/featureStore.ts tests/featureStore.test.ts
git commit -m "feat: tag FeatureStore change notifications with local/remote origin"
```

---

## Task 2: Persistence listener tolerates the origin arg

**Files:**
- Modify: `src/indexedDbPersistence.ts`
- Test: `tests/indexedDbPersistence.test.ts` (no change needed; just re-run)

The persistence adapter persists BOTH local and remote changes (disk holds everything), so it simply ignores origin. TypeScript allows a 1-arg listener where a 2-arg type is expected, so this is defensive/explicit rather than strictly required.

- [ ] **Step 1: Confirm the current attach listener**

Read `src/indexedDbPersistence.ts`. The `attach` method contains:
```typescript
    const off = store.onChange((ids) => {
      for (const id of ids) this.scheduler.markDirty(id);
    });
```

- [ ] **Step 2: Make the ignored origin explicit**

Change it to:
```typescript
    const off = store.onChange((ids, _origin) => {
      // Persist both local and remote changes — disk holds the full set.
      for (const id of ids) this.scheduler.markDirty(id);
    });
```

- [ ] **Step 3: Run persistence tests + typecheck**

Run: `npx vitest run tests/indexedDbPersistence.test.ts && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/indexedDbPersistence.ts
git commit -m "refactor: make persistence ignore change origin explicitly"
```

---

## Task 3: Protocol — `idsNeeded`

**Files:**
- Create: `src/syncProtocol.ts`
- Test: `tests/syncProtocol.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/syncProtocol.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { idsNeeded } from "../src/syncProtocol.js";

describe("idsNeeded", () => {
  it("requests ids the remote has that the local lacks", () => {
    expect(idsNeeded({}, { a: 1, b: 2 }).sort()).toEqual(["a", "b"]);
  });

  it("requests ids the remote has newer", () => {
    expect(idsNeeded({ a: 1 }, { a: 2 })).toEqual(["a"]);
  });

  it("does not request ids the local has newer or equal", () => {
    expect(idsNeeded({ a: 2 }, { a: 2 })).toEqual([]);
    expect(idsNeeded({ a: 3 }, { a: 2 })).toEqual([]);
  });

  it("ignores local-only ids", () => {
    expect(idsNeeded({ a: 1, b: 1 }, { a: 1 })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncProtocol.test.ts`
Expected: FAIL — cannot find module `../src/syncProtocol.js`.

- [ ] **Step 3: Write the implementation** at `src/syncProtocol.ts`:

```typescript
import type { Digest } from "./types.js";

/**
 * Given the local and remote digests (id -> updatedAt), return the ids the local
 * side should request from the remote: ids the remote has that are unknown
 * locally or newer than the local copy. Pure.
 */
export function idsNeeded(local: Digest, remote: Digest): string[] {
  const need: string[] = [];
  for (const [id, remoteTs] of Object.entries(remote)) {
    const localTs = local[id];
    if (localTs === undefined || remoteTs > localTs) need.push(id);
  }
  return need;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncProtocol.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/syncProtocol.ts tests/syncProtocol.test.ts
git commit -m "feat: add idsNeeded reconcile primitive"
```

---

## Task 4: Protocol — `parseFeature` validation boundary

**Files:**
- Modify: `src/syncProtocol.ts`
- Test: `tests/syncProtocol.test.ts`

- [ ] **Step 1: Append the failing test to `tests/syncProtocol.test.ts`**

```typescript
import { parseFeature } from "../src/syncProtocol.js";

function validFeatureObject() {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties: {
      id: "f1",
      author: "A",
      authorDeviceId: "dev-a",
      createdAt: 100,
      updatedAt: 200,
      deleted: false,
      kind: "marker",
      label: "x",
      color: "red",
    },
  };
}

describe("parseFeature", () => {
  it("accepts a well-formed feature and returns it", () => {
    const f = validFeatureObject();
    expect(parseFeature(f)).toEqual(f);
  });

  it("rejects non-objects", () => {
    expect(parseFeature(null)).toBeNull();
    expect(parseFeature("nope")).toBeNull();
    expect(parseFeature(42)).toBeNull();
  });

  it("rejects a missing or empty id", () => {
    const f = validFeatureObject();
    delete (f.properties as Record<string, unknown>).id;
    expect(parseFeature(f)).toBeNull();
    const f2 = validFeatureObject();
    f2.properties.id = "";
    expect(parseFeature(f2)).toBeNull();
  });

  it("rejects a non-finite updatedAt (NaN/missing) that would poison LWW", () => {
    const f = validFeatureObject();
    (f.properties as Record<string, unknown>).updatedAt = Number.NaN;
    expect(parseFeature(f)).toBeNull();
    const f2 = validFeatureObject();
    delete (f2.properties as Record<string, unknown>).updatedAt;
    expect(parseFeature(f2)).toBeNull();
  });

  it("rejects a missing authorDeviceId or kind", () => {
    const f = validFeatureObject();
    delete (f.properties as Record<string, unknown>).authorDeviceId;
    expect(parseFeature(f)).toBeNull();
    const f2 = validFeatureObject();
    delete (f2.properties as Record<string, unknown>).kind;
    expect(parseFeature(f2)).toBeNull();
  });

  it("rejects a non-boolean deleted", () => {
    const f = validFeatureObject();
    (f.properties as Record<string, unknown>).deleted = "yes";
    expect(parseFeature(f)).toBeNull();
  });

  it("rejects a missing geometry", () => {
    const f = validFeatureObject();
    delete (f as Record<string, unknown>).geometry;
    expect(parseFeature(f)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncProtocol.test.ts`
Expected: FAIL — `parseFeature is not a function`.

- [ ] **Step 3: Add to `src/syncProtocol.ts`**

Add the import at the top (merge with existing imports):
```typescript
import type { Digest, SarFeature, FeatureKind } from "./types.js";
```

Add the function:
```typescript
const VALID_KINDS: ReadonlySet<FeatureKind> = new Set([
  "marker",
  "track",
  "line",
  "polygon",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Validate an untrusted value as a SarFeature. Returns the value typed as
 * SarFeature if every required property is well-formed, else null. Guards
 * especially against a non-finite updatedAt, which would poison digest()/LWW.
 * Pure; does not mutate the input.
 */
export function parseFeature(value: unknown): SarFeature | null {
  if (!isRecord(value)) return null;
  if (value.type !== "Feature") return null;
  if (!isRecord(value.geometry)) return null;
  const p = value.properties;
  if (!isRecord(p)) return null;
  if (typeof p.id !== "string" || p.id.length === 0) return null;
  if (typeof p.updatedAt !== "number" || !Number.isFinite(p.updatedAt)) {
    return null;
  }
  if (typeof p.createdAt !== "number" || !Number.isFinite(p.createdAt)) {
    return null;
  }
  if (typeof p.authorDeviceId !== "string" || p.authorDeviceId.length === 0) {
    return null;
  }
  if (typeof p.author !== "string") return null;
  if (typeof p.deleted !== "boolean") return null;
  if (typeof p.kind !== "string" || !VALID_KINDS.has(p.kind as FeatureKind)) {
    return null;
  }
  return value as unknown as SarFeature;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncProtocol.test.ts`
Expected: PASS — all syncProtocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/syncProtocol.ts tests/syncProtocol.test.ts
git commit -m "feat: add parseFeature validation boundary"
```

---

## Task 5: Protocol — `SyncMessage` types & `parseMessage`

**Files:**
- Modify: `src/syncProtocol.ts`
- Test: `tests/syncProtocol.test.ts`

- [ ] **Step 1: Append the failing test to `tests/syncProtocol.test.ts`**

```typescript
import { parseMessage } from "../src/syncProtocol.js";

describe("parseMessage", () => {
  it("parses a digest message", () => {
    const raw = JSON.stringify({ type: "digest", entries: { a: 1 } });
    expect(parseMessage(raw)).toEqual({ type: "digest", entries: { a: 1 } });
  });

  it("parses a need message", () => {
    const raw = JSON.stringify({ type: "need", ids: ["a", "b"] });
    expect(parseMessage(raw)).toEqual({ type: "need", ids: ["a", "b"] });
  });

  it("parses a features message, validating each feature", () => {
    const feature = validFeatureObject();
    const raw = JSON.stringify({ type: "features", features: [feature] });
    expect(parseMessage(raw)).toEqual({ type: "features", features: [feature] });
  });

  it("drops invalid features from a features message but keeps valid ones", () => {
    const good = validFeatureObject();
    const bad = { type: "Feature", properties: { id: "" } };
    const raw = JSON.stringify({ type: "features", features: [good, bad] });
    expect(parseMessage(raw)).toEqual({ type: "features", features: [good] });
  });

  it("parses an upsert message", () => {
    const feature = validFeatureObject();
    const raw = JSON.stringify({ type: "upsert", features: [feature] });
    expect(parseMessage(raw)).toEqual({ type: "upsert", features: [feature] });
  });

  it("returns null on malformed JSON", () => {
    expect(parseMessage("{not json")).toBeNull();
  });

  it("returns null on an unknown message type", () => {
    expect(parseMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });

  it("returns null when digest entries is not an object", () => {
    expect(parseMessage(JSON.stringify({ type: "digest", entries: 5 }))).toBeNull();
  });

  it("returns null when need ids is not an array of strings", () => {
    expect(parseMessage(JSON.stringify({ type: "need", ids: "a" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncProtocol.test.ts`
Expected: FAIL — `parseMessage is not a function`.

- [ ] **Step 3: Add to `src/syncProtocol.ts`**

Add the message types near the top (after imports):
```typescript
export type SyncMessage =
  | { type: "digest"; entries: Digest }
  | { type: "need"; ids: string[] }
  | { type: "features"; features: SarFeature[] }
  | { type: "upsert"; features: SarFeature[] };
```

Add the parser:
```typescript
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNumberRecord(v: unknown): v is Digest {
  if (!isRecord(v)) return false;
  return Object.values(v).every(
    (n) => typeof n === "number" && Number.isFinite(n),
  );
}

/** Collect the valid features from an unknown array; drop invalid ones. */
function parseFeatureArray(value: unknown): SarFeature[] | null {
  if (!Array.isArray(value)) return null;
  const out: SarFeature[] = [];
  for (const item of value) {
    const f = parseFeature(item);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Parse and validate an untrusted wire string into a SyncMessage, or null if it
 * is malformed. For features/upsert, invalid individual features are dropped
 * (logged by the caller); the message itself stays valid. Pure.
 */
export function parseMessage(raw: string): SyncMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  switch (parsed.type) {
    case "digest":
      return isNumberRecord(parsed.entries)
        ? { type: "digest", entries: parsed.entries }
        : null;
    case "need":
      return isStringArray(parsed.ids)
        ? { type: "need", ids: parsed.ids }
        : null;
    case "features": {
      const features = parseFeatureArray(parsed.features);
      return features ? { type: "features", features } : null;
    }
    case "upsert": {
      const features = parseFeatureArray(parsed.features);
      return features ? { type: "upsert", features } : null;
    }
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncProtocol.test.ts`
Expected: PASS — all syncProtocol tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/syncProtocol.ts tests/syncProtocol.test.ts
git commit -m "feat: add SyncMessage types and parseMessage validator"
```

---

## Task 6: Connection interface & in-memory pair

**Files:**
- Create: `src/connection.ts`
- Test: `tests/connection.test.ts`

- [ ] **Step 1: Write the failing test** at `tests/connection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { connectionPair } from "../src/connection.js";

describe("connectionPair", () => {
  it("delivers a message sent on one endpoint to the other", () => {
    const [a, b] = connectionPair();
    const received: string[] = [];
    b.onMessage((data) => received.push(data));
    a.send("hello");
    expect(received).toEqual(["hello"]);
  });

  it("is bidirectional", () => {
    const [a, b] = connectionPair();
    const atB: string[] = [];
    const atA: string[] = [];
    b.onMessage((d) => atB.push(d));
    a.onMessage((d) => atA.push(d));
    a.send("to-b");
    b.send("to-a");
    expect(atB).toEqual(["to-b"]);
    expect(atA).toEqual(["to-a"]);
  });

  it("fires onOpen for both endpoints when opened", () => {
    const [a, b] = connectionPair();
    let aOpen = false;
    let bOpen = false;
    a.onOpen(() => (aOpen = true));
    b.onOpen(() => (bOpen = true));
    a.open();
    expect(aOpen).toBe(true);
    expect(bOpen).toBe(true);
  });

  it("fires onClose on both endpoints and stops delivering after close", () => {
    const [a, b] = connectionPair();
    let aClosed = false;
    let bClosed = false;
    a.onClose(() => (aClosed = true));
    b.onClose(() => (bClosed = true));
    const received: string[] = [];
    b.onMessage((d) => received.push(d));
    a.close();
    expect(aClosed).toBe(true);
    expect(bClosed).toBe(true);
    a.send("after-close"); // swallowed, not delivered
    expect(received).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/connection.test.ts`
Expected: FAIL — cannot find module `../src/connection.js`.

- [ ] **Step 3: Write the implementation** at `src/connection.ts`:

```typescript
export interface Connection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** Test/in-memory endpoint. `open()` simulates the transport opening. */
export interface InMemoryConnection extends Connection {
  open(): void;
}

class MemoryEndpoint implements InMemoryConnection {
  private messageHandlers: ((data: string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private closed = false;
  peer: MemoryEndpoint | null = null;

  send(data: string): void {
    if (this.closed || !this.peer || this.peer.closed) return;
    // Deliver synchronously to the peer's message handlers.
    for (const h of this.peer.messageHandlers) h(data);
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

  fireOpen(): void {
    for (const h of this.openHandlers) h();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
    if (this.peer && !this.peer.closed) this.peer.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  open(): void {
    this.fireOpen();
    if (this.peer) this.peer.fireOpen();
  }
}

/**
 * Create two linked in-memory connection endpoints. A message sent on one is
 * delivered synchronously to the other's message handlers. Calling open() on
 * either fires onOpen on both; close() fires onClose on both and stops delivery.
 */
export function connectionPair(): [InMemoryConnection, InMemoryConnection] {
  const a = new MemoryEndpoint();
  const b = new MemoryEndpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/connection.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/connection.ts tests/connection.test.ts
git commit -m "feat: add Connection interface and in-memory connectionPair"
```

---

## Task 7: SyncSession — handshake & reconcile

**Files:**
- Create: `src/syncSession.ts`
- Test: `tests/syncSession.test.ts`

The SyncSession drives one connection: on `start()` it sends its digest; it answers `digest`→`need`, `need`→`features`, and `features`→`applyDelta`. Live `upsert` handling and the onChange broadcast come in Task 8.

- [ ] **Step 1: Write the failing test** at `tests/syncSession.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SyncSession } from "../src/syncSession.js";
import { connectionPair } from "../src/connection.js";
import { FeatureStore } from "../src/featureStore.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

function seed(store: FeatureStore, identity: typeof A, id: string, label: string) {
  const s = new FeatureStore({ now: () => 1, newId: () => id });
  // helper not used; inline create below
}

describe("SyncSession handshake", () => {
  it("converges two stores with disjoint features after start()", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "from-a",
      color: "",
    });
    storeB.create(B, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [2, 2] },
      label: "from-b",
      color: "",
    });

    const sessionA = new SyncSession(storeA, connA);
    const sessionB = new SyncSession(storeB, connB);
    sessionA.start();
    sessionB.start();

    expect(storeA.toGeoJSON()).toEqual(storeB.toGeoJSON());
    expect(storeA.list()).toHaveLength(2);
  });

  it("pulls a newer remote version during handshake", () => {
    const [connA, connB] = connectionPair();
    let tA = 1;
    const storeA = new FeatureStore({ now: () => tA, newId: () => "x" });
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "old",
      color: "",
    });
    // storeB has the same id but newer.
    const storeB = new FeatureStore({ now: () => 5, newId: () => "x" });
    storeB.create(B, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [9, 9] },
      label: "new",
      color: "",
    });

    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();

    expect(storeA.getRaw("x")?.properties.label).toBe("new");
    expect(storeB.getRaw("x")?.properties.label).toBe("new");
  });

  it("ignores a malformed inbound message without throwing", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const session = new SyncSession(storeA, connA);
    session.start();
    // Peer sends garbage directly.
    expect(() => connB.send("{not valid")).not.toThrow();
  });
});
```

Note: remove the unused `seed` helper if your linter complains — there is no linter configured, so it is harmless, but you may delete it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncSession.test.ts`
Expected: FAIL — cannot find module `../src/syncSession.js`.

- [ ] **Step 3: Write the implementation** at `src/syncSession.ts`:

```typescript
import type { FeatureStore } from "./featureStore.js";
import type { Connection } from "./connection.js";
import { parseMessage, idsNeeded } from "./syncProtocol.js";

/**
 * Drives the sync protocol over one Connection against one FeatureStore.
 * On start() it sends its digest; it answers digest->need, need->features,
 * features->applyDelta. Live upsert broadcast is added separately.
 */
export class SyncSession {
  constructor(
    private store: FeatureStore,
    private conn: Connection,
  ) {
    this.conn.onMessage((data) => this.handle(data));
  }

  /** Begin the handshake by sending our digest. */
  start(): void {
    this.send({ type: "digest", entries: this.store.digest() });
  }

  private send(msg: { type: string; [k: string]: unknown }): void {
    this.conn.send(JSON.stringify(msg));
  }

  private handle(data: string): void {
    const msg = parseMessage(data);
    if (!msg) {
      console.error("SyncSession: dropping malformed message");
      return;
    }
    switch (msg.type) {
      case "digest": {
        const need = idsNeeded(this.store.digest(), msg.entries);
        if (need.length > 0) this.send({ type: "need", ids: need });
        break;
      }
      case "need": {
        const features = this.store.featuresFor(msg.ids);
        if (features.length > 0) this.send({ type: "features", features });
        break;
      }
      case "features": {
        this.store.applyDelta(msg.features);
        break;
      }
      case "upsert": {
        this.store.applyDelta(msg.features);
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncSession.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/syncSession.ts tests/syncSession.test.ts
git commit -m "feat: add SyncSession handshake and reconcile"
```

---

## Task 8: SyncSession — live local-edit broadcast

**Files:**
- Modify: `src/syncSession.ts`
- Test: `tests/syncSession.test.ts`

A live local edit on one store must propagate to the peer; a remote-origin change must NOT be rebroadcast (loop prevention).

- [ ] **Step 1: Append the failing tests to `tests/syncSession.test.ts`**

```typescript
describe("SyncSession live broadcast", () => {
  it("propagates a local edit made after the handshake", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();

    // After handshake, A creates a feature live.
    const f = storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "live",
      color: "",
    });
    expect(storeB.getRaw(f.properties.id)?.properties.label).toBe("live");
  });

  it("does not rebroadcast a remote-origin change (no echo loop)", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();

    // Count messages B sends to A after handshake.
    let bToA = 0;
    connB.onMessage(() => {}); // ensure handlers exist
    const origSend = connB.send.bind(connB);
    (connB as unknown as { send: (d: string) => void }).send = (d: string) => {
      bToA++;
      origSend(d);
    };

    // A creates live -> B receives (remote) -> B must NOT send anything back.
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "live",
      color: "",
    });
    expect(bToA).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/syncSession.test.ts`
Expected: FAIL — the live edit does not propagate (no broadcast wired yet); first new test fails.

- [ ] **Step 3: Wire the local-edit broadcast in `src/syncSession.ts`**

Add a `ChangeOrigin` import and subscribe to the store in the constructor. Update the imports:
```typescript
import type { FeatureStore, ChangeOrigin } from "./featureStore.js";
import type { Connection } from "./connection.js";
import { parseMessage, idsNeeded } from "./syncProtocol.js";
```

Add an unsubscribe field and subscribe in the constructor:
```typescript
  private offChange: () => void;

  constructor(
    private store: FeatureStore,
    private conn: Connection,
  ) {
    this.conn.onMessage((data) => this.handle(data));
    this.offChange = this.store.onChange((ids, origin) =>
      this.onLocalChange(ids, origin),
    );
  }

  /** Broadcast only local-origin edits; remote-origin changes are terminal. */
  private onLocalChange(ids: readonly string[], origin: ChangeOrigin): void {
    if (origin !== "local") return;
    const features = this.store.featuresFor(ids);
    if (features.length > 0) this.send({ type: "upsert", features });
  }

  /** Detach the change listener (call when the session ends). */
  stop(): void {
    this.offChange();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/syncSession.test.ts`
Expected: PASS — all SyncSession tests pass (handshake + live broadcast).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/syncSession.ts tests/syncSession.test.ts
git commit -m "feat: broadcast local-origin edits live; suppress remote echo"
```

---

## Task 9: Two-session convergence proof (integration)

**Files:**
- Test: `tests/syncSessionConvergence.test.ts`

Proves the central property end-to-end: two stores, after a handshake and a sequence of live edits on both sides, converge to identical `toGeoJSON()`.

- [ ] **Step 1: Write the test** at `tests/syncSessionConvergence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SyncSession } from "../src/syncSession.js";
import { connectionPair } from "../src/connection.js";
import { FeatureStore } from "../src/featureStore.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

describe("two-session convergence", () => {
  it("converges after a handshake plus interleaved live edits and a delete", () => {
    const [connA, connB] = connectionPair();
    let tA = 10;
    let tB = 10;
    let nA = 0;
    let nB = 0;
    const storeA = new FeatureStore({ now: () => tA, newId: () => `a-${++nA}` });
    const storeB = new FeatureStore({ now: () => tB, newId: () => `b-${++nB}` });

    // Pre-handshake state on each side.
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "a-pre",
      color: "",
    });
    storeB.create(B, {
      kind: "line",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      label: "b-pre",
      color: "",
    });

    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();
    // After handshake both have 2 features.
    expect(storeA.list()).toHaveLength(2);
    expect(storeB.list()).toHaveLength(2);

    // Live edits on both sides.
    tA = 20;
    const aLive = storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [3, 3] },
      label: "a-live",
      color: "",
    });
    tB = 21;
    storeB.create(B, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [4, 4] },
      label: "b-live",
      color: "",
    });

    // A edits its own pre-handshake feature, then deletes its live one.
    tA = 30;
    storeA.update(A, "a-1", { label: "a-pre-edited" });
    tA = 31;
    storeA.remove(A, aLive.properties.id);

    expect(storeA.toGeoJSON()).toEqual(storeB.toGeoJSON());
    expect(storeA.list()).toHaveLength(3); // 4 created, 1 deleted
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/syncSessionConvergence.test.ts`
Expected: PASS — 1 test. If it FAILS, it reveals a real protocol gap (a live edit or delete not propagating, or divergence) — investigate the session/store, do not weaken the test.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add tests/syncSessionConvergence.test.ts
git commit -m "test: prove two-session live convergence"
```

---

## Task 10: Public exports & full suite green

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the new public surface to `src/index.ts`**

Append (keep all existing exports):
```typescript
export {
  idsNeeded,
  parseFeature,
  parseMessage,
  type SyncMessage,
} from "./syncProtocol.js";
export {
  connectionPair,
  type Connection,
  type InMemoryConnection,
} from "./connection.js";
export { SyncSession } from "./syncSession.js";
export { type ChangeOrigin } from "./featureStore.js";
```

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL tests pass across every file; `tsc --noEmit` exits 0 with no duplicate-export error. Report the actual total test count.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export sync protocol and session public surface"
```

---

## Self-Review

**Spec coverage** (against `2026-06-18-syncclient-server-design.md`, the parts in Plan A scope):
- Origin-tagged change seam (`ChangeOrigin`, local for create/update/remove, remote for applyDelta) → Task 1. ✅
- Persistence listener tolerates origin → Task 2. ✅
- `idsNeeded` promoted to core, tested → Task 3. ✅
- `parseFeature` validation boundary (rejects NaN/missing updatedAt, missing id/authorDeviceId/kind, non-boolean deleted, missing geometry) → Task 4. ✅
- `SyncMessage` tagged union + `parseMessage` (bad JSON, unknown type, malformed fields rejected; invalid features dropped from a batch) → Task 5. ✅
- `Connection` interface + in-memory `connectionPair` → Task 6. ✅
- SyncSession handshake (digest→need→features→applyDelta), symmetric, malformed-message tolerance → Task 7. ✅
- SyncSession live broadcast of local-only edits; remote-origin not rebroadcast (loop prevention) → Task 8. ✅
- Two-session convergence proof (handshake + live edits + delete) → Task 9. ✅
- Public exports → Task 10. ✅
- Deferred to Plan B (correctly out of scope here): SyncClient reconnect/backoff, SyncServer relay, multi-peer integration, real WebSocket bindings.

**Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. (One harmless unused `seed` helper in Task 7's test is explicitly called out with permission to delete.) ✅

**Type consistency:**
- `ChangeOrigin = "local" | "remote"`, `ChangeListener = (ids, origin) => void` — defined Task 1, consumed by SyncSession Task 8, exported Task 10. ✅
- `SyncMessage` union shape identical in Task 5 (definition), Task 7 (`handle` switch), Task 8 (upsert send). ✅
- `parseMessage`/`parseFeature`/`idsNeeded` signatures consistent across Tasks 3–5, 7. ✅
- `Connection` (`send`/`onMessage`/`onOpen`/`onClose`/`close`) + `InMemoryConnection.open()` consistent across Task 6 and its consumers (Tasks 7–9). ✅
- Store methods used (`digest`, `featuresFor`, `applyDelta`, `onChange`, `toGeoJSON`, `list`, `getRaw`, `create/update/remove`) all exist in the current FeatureStore. ✅

**Note on a deliberate simplification:** SyncSession sends its digest on `start()` and reacts to the peer's digest; it does not itself depend on `Connection.onOpen` (the caller decides when to `start()`). Reconnect/open orchestration is Plan B's `SyncClient`. This keeps the session a pure protocol driver and is noted so a reviewer does not flag the unused open-handshake coupling.
