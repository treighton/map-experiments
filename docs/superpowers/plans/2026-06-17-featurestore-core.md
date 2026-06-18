# FeatureStore Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, fully unit-tested OR-Set/LWW FeatureStore and Identity modules — the shared CRDT heart that the client, server, and sync layer all depend on.

**Architecture:** A standalone TypeScript package with zero UI/network/storage dependencies. Map state is an OR-Set of GeoJSON features keyed by `id`, merged with last-write-wins by `updatedAt` (tie-broken by `authorDeviceId`). Deletes are tombstones. A persistence interface is defined but its only implementation in this plan is in-memory; IndexedDB comes in a later plan. Identity generates and stores a stable `{ callsign, deviceId }`.

**Tech Stack:** TypeScript, Vitest, Node 24, `uuid`. No framework, no DOM, no network.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Package manifest, scripts, deps |
| `tsconfig.json` | TypeScript config |
| `vitest.config.ts` | Test runner config |
| `src/types.ts` | `SarFeature`, `FeatureProperties`, `FeatureKind`, `Geometry` types |
| `src/uuid.ts` | Thin UUID wrapper (so it can be mocked in tests) |
| `src/merge.ts` | Pure merge functions: `mergeFeature`, `mergeAll` |
| `src/featureStore.ts` | `FeatureStore` class: upsert/edit/delete, ownership guard, digest, applyDelta, export |
| `src/identity.ts` | `Identity`: generate/load `{ callsign, deviceId }` via an injected key-value store |
| `src/index.ts` | Public exports |
| `tests/merge.test.ts` | Merge/CRDT property tests |
| `tests/featureStore.test.ts` | Store behavior + ownership + digest/delta tests |
| `tests/identity.test.ts` | Identity generation/persistence tests |

**Decomposition rationale:** `merge.ts` holds the pure LWW resolution so it is testable with plain objects and reusable by both store and (later) server. `featureStore.ts` orchestrates merge + ownership + the digest/delta API but delegates all conflict resolution to `merge.ts`. `identity.ts` is independent of the store.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@sartools/feature-store",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "uuid": "^11.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
```

- [ ] **Step 4: Create placeholder `src/index.ts`**

```typescript
export {};
```

- [ ] **Step 5: Install and verify typecheck passes**

Run: `npm install && npm run typecheck`
Expected: installs cleanly, `tsc --noEmit` exits 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts src/index.ts package-lock.json
git commit -m "chore: scaffold feature-store package"
```

---

## Task 2: Core types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export type FeatureKind = "marker" | "track" | "line" | "polygon";

export type Geometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] };

export interface FeatureProperties {
  id: string;
  author: string;
  authorDeviceId: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  kind: FeatureKind;
  label: string;
  color: string;
}

export interface SarFeature {
  type: "Feature";
  geometry: Geometry;
  properties: FeatureProperties;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: SarFeature[];
}

/** Map of feature id -> updatedAt, exchanged during sync reconcile. */
export type Digest = Record<string, number>;
```

- [ ] **Step 2: Export from `src/index.ts`**

```typescript
export * from "./types.js";
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/index.ts
git commit -m "feat: add core feature types"
```

---

## Task 3: UUID wrapper

**Files:**
- Create: `src/uuid.ts`

- [ ] **Step 1: Write `src/uuid.ts`**

```typescript
import { v4 } from "uuid";

/** Wrapped so tests can stub id generation deterministically. */
export function newId(): string {
  return v4();
}
```

- [ ] **Step 2: Export from `src/index.ts`**

```typescript
export * from "./types.js";
export { newId } from "./uuid.js";
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/uuid.ts src/index.ts
git commit -m "feat: add uuid wrapper"
```

---

## Task 4: Pure merge — single feature LWW

**Files:**
- Create: `src/merge.ts`
- Test: `tests/merge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { mergeFeature } from "../src/merge.js";
import type { SarFeature } from "../src/types.js";

function feat(over: Partial<SarFeature["properties"]> = {}): SarFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      id: "f1",
      author: "A",
      authorDeviceId: "dev-a",
      createdAt: 100,
      updatedAt: 100,
      deleted: false,
      kind: "marker",
      label: "",
      color: "",
      ...over,
    },
  };
}

describe("mergeFeature", () => {
  it("keeps the feature with the newer updatedAt", () => {
    const older = feat({ updatedAt: 100, label: "old" });
    const newer = feat({ updatedAt: 200, label: "new" });
    expect(mergeFeature(older, newer).properties.label).toBe("new");
    expect(mergeFeature(newer, older).properties.label).toBe("new");
  });

  it("breaks ties by authorDeviceId (higher wins)", () => {
    const a = feat({ updatedAt: 100, authorDeviceId: "dev-a", label: "a" });
    const b = feat({ updatedAt: 100, authorDeviceId: "dev-b", label: "b" });
    expect(mergeFeature(a, b).properties.label).toBe("b");
    expect(mergeFeature(b, a).properties.label).toBe("b");
  });

  it("is idempotent", () => {
    const a = feat({ updatedAt: 100 });
    expect(mergeFeature(a, a)).toEqual(a);
  });

  it("a later delete wins over an earlier edit", () => {
    const edit = feat({ updatedAt: 100, deleted: false });
    const del = feat({ updatedAt: 200, deleted: true });
    expect(mergeFeature(edit, del).properties.deleted).toBe(true);
  });

  it("a later edit resurrects over an earlier delete", () => {
    const del = feat({ updatedAt: 100, deleted: true });
    const edit = feat({ updatedAt: 200, deleted: false });
    expect(mergeFeature(del, edit).properties.deleted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/merge.test.ts`
Expected: FAIL — cannot find module `../src/merge.js` / `mergeFeature is not a function`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { SarFeature } from "./types.js";

/**
 * Resolve two versions of the same feature by last-write-wins.
 * Newer updatedAt wins; ties broken by higher authorDeviceId for determinism.
 * Pure: returns one of the inputs unchanged.
 */
export function mergeFeature(a: SarFeature, b: SarFeature): SarFeature {
  const pa = a.properties;
  const pb = b.properties;
  if (pa.updatedAt !== pb.updatedAt) {
    return pa.updatedAt > pb.updatedAt ? a : b;
  }
  return pa.authorDeviceId >= pb.authorDeviceId ? a : b;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/merge.test.ts`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/merge.ts tests/merge.test.ts
git commit -m "feat: add single-feature LWW merge"
```

---

## Task 5: Pure merge — merge feature collections

**Files:**
- Modify: `src/merge.ts`
- Test: `tests/merge.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/merge.test.ts`)**

```typescript
import { mergeAll } from "../src/merge.js";

describe("mergeAll", () => {
  it("unions disjoint feature sets", () => {
    const local = new Map([["f1", feat({ id: "f1" })]]);
    const incoming = [feat({ id: "f2" })];
    const out = mergeAll(local, incoming);
    expect([...out.keys()].sort()).toEqual(["f1", "f2"]);
  });

  it("resolves overlapping ids by LWW", () => {
    const local = new Map([["f1", feat({ id: "f1", updatedAt: 100, label: "old" })]]);
    const incoming = [feat({ id: "f1", updatedAt: 200, label: "new" })];
    const out = mergeAll(local, incoming);
    expect(out.get("f1")!.properties.label).toBe("new");
  });

  it("is commutative on final state regardless of input order", () => {
    const x = feat({ id: "f1", updatedAt: 100 });
    const y = feat({ id: "f1", updatedAt: 200 });
    const ab = mergeAll(new Map([["f1", x]]), [y]);
    const ba = mergeAll(new Map([["f1", y]]), [x]);
    expect(ab.get("f1")).toEqual(ba.get("f1"));
  });

  it("does not mutate the input map", () => {
    const local = new Map([["f1", feat({ id: "f1", updatedAt: 100 })]]);
    mergeAll(local, [feat({ id: "f1", updatedAt: 200 })]);
    expect(local.get("f1")!.properties.updatedAt).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/merge.test.ts`
Expected: FAIL — `mergeAll is not a function`.

- [ ] **Step 3: Add implementation to `src/merge.ts`**

```typescript
/**
 * Merge incoming features into a copy of the local map (id -> feature).
 * Pure: returns a new Map, never mutates the input.
 */
export function mergeAll(
  local: ReadonlyMap<string, SarFeature>,
  incoming: readonly SarFeature[],
): Map<string, SarFeature> {
  const out = new Map(local);
  for (const f of incoming) {
    const existing = out.get(f.properties.id);
    out.set(f.properties.id, existing ? mergeFeature(existing, f) : f);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/merge.test.ts`
Expected: PASS — all merge tests (single + collection) pass.

- [ ] **Step 5: Commit**

```bash
git add src/merge.ts tests/merge.test.ts
git commit -m "feat: add collection merge"
```

---

## Task 6: FeatureStore — create & query

**Files:**
- Create: `src/featureStore.ts`
- Test: `tests/featureStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { FeatureStore } from "../src/featureStore.js";

const ME = { callsign: "Team3-Mike", deviceId: "dev-me" };

function makeStore() {
  return new FeatureStore({ now: () => 1000, newId: () => "id-1" });
}

describe("FeatureStore create/query", () => {
  it("creates a feature stamped with author and timestamps", () => {
    const store = makeStore();
    const f = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "tent",
      color: "red",
    });
    expect(f.properties.id).toBe("id-1");
    expect(f.properties.author).toBe("Team3-Mike");
    expect(f.properties.authorDeviceId).toBe("dev-me");
    expect(f.properties.createdAt).toBe(1000);
    expect(f.properties.updatedAt).toBe(1000);
    expect(f.properties.deleted).toBe(false);
  });

  it("lists only non-deleted features", () => {
    const store = makeStore();
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(store.list()).toHaveLength(1);
  });

  it("exports a GeoJSON FeatureCollection of non-deleted features", () => {
    const store = makeStore();
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    const fc = store.toGeoJSON();
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: FAIL — cannot find module `../src/featureStore.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type {
  SarFeature,
  FeatureKind,
  Geometry,
  FeatureCollection,
} from "./types.js";
import { newId as defaultNewId } from "./uuid.js";

export interface Identity {
  callsign: string;
  deviceId: string;
}

export interface CreateInput {
  kind: FeatureKind;
  geometry: Geometry;
  label: string;
  color: string;
}

export interface StoreDeps {
  now?: () => number;
  newId?: () => string;
}

export class FeatureStore {
  private features = new Map<string, SarFeature>();
  private now: () => number;
  private newId: () => string;

  constructor(deps: StoreDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? defaultNewId;
  }

  create(identity: Identity, input: CreateInput): SarFeature {
    const t = this.now();
    const f: SarFeature = {
      type: "Feature",
      geometry: input.geometry,
      properties: {
        id: this.newId(),
        author: identity.callsign,
        authorDeviceId: identity.deviceId,
        createdAt: t,
        updatedAt: t,
        deleted: false,
        kind: input.kind,
        label: input.label,
        color: input.color,
      },
    };
    this.features.set(f.properties.id, f);
    return f;
  }

  list(): SarFeature[] {
    return [...this.features.values()].filter((f) => !f.properties.deleted);
  }

  toGeoJSON(): FeatureCollection {
    return { type: "FeatureCollection", features: this.list() };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/featureStore.ts tests/featureStore.test.ts
git commit -m "feat: add FeatureStore create and query"
```

---

## Task 7: FeatureStore — ownership-scoped edit & delete

**Files:**
- Modify: `src/featureStore.ts`
- Test: `tests/featureStore.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/featureStore.test.ts`)**

```typescript
const OTHER = { callsign: "Team1-Sue", deviceId: "dev-other" };

describe("FeatureStore ownership", () => {
  it("lets the author edit their own feature and bumps updatedAt", () => {
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "old",
      color: "",
    });
    t = 2000;
    const updated = store.update(ME, "id-1", { label: "new" });
    expect(updated.properties.label).toBe("new");
    expect(updated.properties.updatedAt).toBe(2000);
  });

  it("throws when a non-author tries to edit", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(() => store.update(OTHER, "id-1", { label: "x" })).toThrow(
      /not the author/i,
    );
  });

  it("soft-deletes via tombstone and removes from list()", () => {
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    t = 2000;
    store.remove(ME, "id-1");
    expect(store.list()).toHaveLength(0);
    expect(store.getRaw("id-1")!.properties.deleted).toBe(true);
    expect(store.getRaw("id-1")!.properties.updatedAt).toBe(2000);
  });

  it("throws when a non-author tries to delete", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(() => store.remove(OTHER, "id-1")).toThrow(/not the author/i);
  });

  it("throws when editing a missing feature", () => {
    const store = makeStore();
    expect(() => store.update(ME, "nope", { label: "x" })).toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: FAIL — `store.update is not a function`.

- [ ] **Step 3: Add methods to `FeatureStore` (in `src/featureStore.ts`)**

Add this `EditableFields` type near the other interfaces:

```typescript
export type EditableFields = Partial<
  Pick<SarFeature["properties"], "label" | "color"> & {
    geometry: Geometry;
  }
>;
```

Add these methods inside the `FeatureStore` class:

```typescript
  getRaw(id: string): SarFeature | undefined {
    return this.features.get(id);
  }

  private requireOwned(identity: Identity, id: string): SarFeature {
    const f = this.features.get(id);
    if (!f) throw new Error(`Feature not found: ${id}`);
    if (f.properties.authorDeviceId !== identity.deviceId) {
      throw new Error(`You are not the author of feature ${id}`);
    }
    return f;
  }

  update(identity: Identity, id: string, edits: EditableFields): SarFeature {
    const current = this.requireOwned(identity, id);
    const { geometry, ...propEdits } = edits;
    const next: SarFeature = {
      type: "Feature",
      geometry: geometry ?? current.geometry,
      properties: {
        ...current.properties,
        ...propEdits,
        updatedAt: this.now(),
      },
    };
    this.features.set(id, next);
    return next;
  }

  remove(identity: Identity, id: string): SarFeature {
    const current = this.requireOwned(identity, id);
    const next: SarFeature = {
      ...current,
      properties: {
        ...current.properties,
        deleted: true,
        updatedAt: this.now(),
      },
    };
    this.features.set(id, next);
    return next;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: PASS — all create/query/ownership tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/featureStore.ts tests/featureStore.test.ts
git commit -m "feat: add ownership-scoped edit and delete"
```

---

## Task 8: FeatureStore — digest & delta sync API

**Files:**
- Modify: `src/featureStore.ts`
- Test: `tests/featureStore.test.ts`

- [ ] **Step 1: Write the failing test (append to `tests/featureStore.test.ts`)**

```typescript
import type { SarFeature } from "../src/types.js";

function externalFeature(over: Partial<SarFeature["properties"]>): SarFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      id: "ext",
      author: "Team1-Sue",
      authorDeviceId: "dev-other",
      createdAt: 100,
      updatedAt: 100,
      deleted: false,
      kind: "marker",
      label: "",
      color: "",
      ...over,
    },
  };
}

describe("FeatureStore sync API", () => {
  it("produces a digest of id -> updatedAt including tombstones", () => {
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "id-1" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    t = 2000;
    store.remove(ME, "id-1");
    expect(store.digest()).toEqual({ "id-1": 2000 });
  });

  it("applyDelta merges external features via LWW", () => {
    const store = makeStore();
    const incoming = externalFeature({ id: "ext", updatedAt: 500, label: "from-peer" });
    store.applyDelta([incoming]);
    expect(store.getRaw("ext")!.properties.label).toBe("from-peer");
  });

  it("applyDelta does not let an older external version overwrite a newer local one", () => {
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "ext" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "local-newer",
      color: "",
    });
    t = 2000;
    store.update(ME, "ext", { label: "local-newest" });
    store.applyDelta([externalFeature({ id: "ext", updatedAt: 500, label: "stale" })]);
    expect(store.getRaw("ext")!.properties.label).toBe("local-newest");
  });

  it("featuresFor returns full features for the requested ids", () => {
    const store = makeStore();
    const f = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(store.featuresFor([f.properties.id, "missing"])).toEqual([f]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: FAIL — `store.digest is not a function`.

- [ ] **Step 3: Add to `src/featureStore.ts`**

Add the import at the top of the file (merge with the existing type import line):

```typescript
import type {
  SarFeature,
  FeatureKind,
  Geometry,
  FeatureCollection,
  Digest,
} from "./types.js";
import { mergeAll } from "./merge.js";
```

Add these methods inside the `FeatureStore` class:

```typescript
  /** id -> updatedAt for every feature, tombstones included. */
  digest(): Digest {
    const out: Digest = {};
    for (const [id, f] of this.features) out[id] = f.properties.updatedAt;
    return out;
  }

  /** Full features for the given ids, skipping any that are unknown. */
  featuresFor(ids: readonly string[]): SarFeature[] {
    const out: SarFeature[] = [];
    for (const id of ids) {
      const f = this.features.get(id);
      if (f) out.push(f);
    }
    return out;
  }

  /** Merge externally-received features via LWW. */
  applyDelta(incoming: readonly SarFeature[]): void {
    this.features = mergeAll(this.features, incoming);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/featureStore.test.ts`
Expected: PASS — all store tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/featureStore.ts tests/featureStore.test.ts
git commit -m "feat: add digest and delta sync API to FeatureStore"
```

---

## Task 9: Two-store convergence (integration)

**Files:**
- Test: `tests/convergence.test.ts`

This proves the core correctness property: two independent stores, after exchanging digests and deltas in both directions, converge to identical state.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { FeatureStore } from "../src/featureStore.js";
import type { Digest } from "../src/types.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

/** Compute which ids `requester` needs from `holder` given holder's digest. */
function idsNeeded(localDigest: Digest, remoteDigest: Digest): string[] {
  const need: string[] = [];
  for (const [id, remoteTs] of Object.entries(remoteDigest)) {
    const localTs = localDigest[id];
    if (localTs === undefined || remoteTs > localTs) need.push(id);
  }
  return need;
}

/** One full bidirectional reconcile between two stores. */
function reconcile(s1: FeatureStore, s2: FeatureStore): void {
  const d1 = s1.digest();
  const d2 = s2.digest();
  // s1 pulls what s2 has newer/unknown
  s1.applyDelta(s2.featuresFor(idsNeeded(d1, d2)));
  // s2 pulls what s1 has newer/unknown
  s2.applyDelta(s1.featuresFor(idsNeeded(d2, d1)));
}

function expectConverged(s1: FeatureStore, s2: FeatureStore): void {
  expect(s1.digest()).toEqual(s2.digest());
  expect(s1.toGeoJSON()).toEqual(s2.toGeoJSON());
}

describe("two-store convergence", () => {
  it("converges after exchanging disjoint features", () => {
    let t = 1;
    const s1 = new FeatureStore({ now: () => t, newId: () => "a1" });
    const s2 = new FeatureStore({ now: () => t, newId: () => "b1" });
    s1.create(A, { kind: "marker", geometry: { type: "Point", coordinates: [1, 1] }, label: "", color: "" });
    s2.create(B, { kind: "marker", geometry: { type: "Point", coordinates: [2, 2] }, label: "", color: "" });
    reconcile(s1, s2);
    expectConverged(s1, s2);
    expect(s1.list()).toHaveLength(2);
  });

  it("propagates a delete to the other store", () => {
    let t = 1;
    const s1 = new FeatureStore({ now: () => t, newId: () => "a1" });
    const s2 = new FeatureStore({ now: () => t, newId: () => "x" });
    s1.create(A, { kind: "marker", geometry: { type: "Point", coordinates: [1, 1] }, label: "", color: "" });
    reconcile(s1, s2);
    expect(s2.list()).toHaveLength(1);
    t = 2;
    s1.remove(A, "a1");
    reconcile(s1, s2);
    expectConverged(s1, s2);
    expect(s2.list()).toHaveLength(0);
  });

  it("converges regardless of reconcile direction order", () => {
    let t = 1;
    const s1 = new FeatureStore({ now: () => t, newId: () => "a1" });
    const s2 = new FeatureStore({ now: () => t, newId: () => "b1" });
    s1.create(A, { kind: "marker", geometry: { type: "Point", coordinates: [1, 1] }, label: "", color: "" });
    s2.create(B, { kind: "marker", geometry: { type: "Point", coordinates: [2, 2] }, label: "", color: "" });
    reconcile(s2, s1); // reversed order
    expectConverged(s1, s2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run tests/convergence.test.ts`
Expected: PASS (the store API from Tasks 6–8 already supports this). If it FAILS, the failure points to a real gap in `digest`/`featuresFor`/`applyDelta` — fix the store, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/convergence.test.ts
git commit -m "test: prove two-store convergence"
```

---

## Task 10: Identity module

**Files:**
- Create: `src/identity.ts`
- Test: `tests/identity.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { loadOrCreateIdentity } from "../src/identity.js";

/** In-memory stand-in for localStorage. */
class MemoryStore {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe("loadOrCreateIdentity", () => {
  it("generates a deviceId on first call and persists it", () => {
    const kv = new MemoryStore();
    const id = loadOrCreateIdentity(kv, "Team3-Mike", { newId: () => "dev-xyz" });
    expect(id).toEqual({ callsign: "Team3-Mike", deviceId: "dev-xyz" });
    expect(kv.getItem("sar.deviceId")).toBe("dev-xyz");
  });

  it("reuses an existing deviceId on later calls", () => {
    const kv = new MemoryStore();
    loadOrCreateIdentity(kv, "Team3-Mike", { newId: () => "dev-first" });
    const again = loadOrCreateIdentity(kv, "Team3-Mike-Renamed", { newId: () => "dev-second" });
    expect(again.deviceId).toBe("dev-first");
    expect(again.callsign).toBe("Team3-Mike-Renamed");
  });

  it("persists the latest callsign", () => {
    const kv = new MemoryStore();
    loadOrCreateIdentity(kv, "Old", { newId: () => "dev-1" });
    loadOrCreateIdentity(kv, "New", { newId: () => "dev-1" });
    expect(kv.getItem("sar.callsign")).toBe("New");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/identity.test.ts`
Expected: FAIL — cannot find module `../src/identity.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { newId as defaultNewId } from "./uuid.js";

export interface Identity {
  callsign: string;
  deviceId: string;
}

/** Minimal key-value interface satisfied by Web Storage (localStorage). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEVICE_KEY = "sar.deviceId";
const CALLSIGN_KEY = "sar.callsign";

export function loadOrCreateIdentity(
  kv: KeyValueStore,
  callsign: string,
  deps: { newId?: () => string } = {},
): Identity {
  const newId = deps.newId ?? defaultNewId;
  let deviceId = kv.getItem(DEVICE_KEY);
  if (!deviceId) {
    deviceId = newId();
    kv.setItem(DEVICE_KEY, deviceId);
  }
  kv.setItem(CALLSIGN_KEY, callsign);
  return { callsign, deviceId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/identity.test.ts`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/identity.ts tests/identity.test.ts
git commit -m "feat: add identity module"
```

---

## Task 11: Public exports & full suite green

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/index.ts` to export the public surface**

```typescript
export * from "./types.js";
export { newId } from "./uuid.js";
export { mergeFeature, mergeAll } from "./merge.js";
export {
  FeatureStore,
  type Identity,
  type CreateInput,
  type EditableFields,
  type StoreDeps,
} from "./featureStore.js";
export {
  loadOrCreateIdentity,
  type KeyValueStore,
} from "./identity.js";
```

Note: `Identity` is intentionally exported from `featureStore.js` as the canonical definition. `identity.ts` declares a structurally identical `Identity`; do not re-export it from `index.ts` to avoid a duplicate-name collision.

- [ ] **Step 2: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: ALL tests pass (merge, featureStore, convergence, identity); `tsc --noEmit` exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: finalize feature-store public exports"
```

---

## Self-Review

**Spec coverage** (against `2026-06-17-collaborative-sar-mapping-design.md`):
- Data model (Feature + required properties) → Task 2 types, Task 6 create. ✅
- OR-Set + LWW by `updatedAt`, tie-break `authorDeviceId` → Tasks 4–5. ✅
- Tombstone soft-delete, resurrection semantics → Tasks 4, 7. ✅
- Ownership guard (client-side; edit/delete only own features) → Task 7. ✅
- GeoJSON export (`FeatureCollection`, non-deleted) → Task 6. ✅
- Digest/delta reconcile primitives → Task 8; convergence proof → Task 9. ✅
- Identity (callsign + stable deviceId, local persistence) → Task 10. ✅
- Pure logic, no UI/network/IndexedDB deps → satisfied (IndexedDB persistence is a later plan; store keeps state in memory now). ✅
- Out of scope here (per spec/decomposition): MapView, DrawController, SyncClient transport, TileManager, Server, IndexedDB persistence — these belong to subsequent plans.

**Placeholder scan:** No TBD/TODO; every code step contains complete code; every command has expected output. ✅

**Type consistency:** `Identity` used identically in `featureStore.ts` and `identity.ts` (callsign + deviceId); export collision explicitly handled in Task 11. Method names consistent across tasks: `create`, `update`, `remove`, `getRaw`, `list`, `toGeoJSON`, `digest`, `featuresFor`, `applyDelta`. `mergeFeature`/`mergeAll` consistent between Tasks 4–5 and their consumers. ✅
