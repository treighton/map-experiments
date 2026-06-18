import { describe, it, expect } from "vitest";
import { FeatureStore } from "../src/featureStore.js";
import type { SarFeature } from "../src/types.js";

const ME = { callsign: "Team3-Mike", deviceId: "dev-me" };
const OTHER = { callsign: "Team1-Sue", deviceId: "dev-other" };

function makeStore() {
  let n = 0;
  return new FeatureStore({ now: () => 1000, newId: () => `id-${++n}` });
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
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "keep" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "keep",
      color: "",
    });
    const store2 = new FeatureStore({ now: () => t, newId: () => "gone" });
    store2.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [3, 4] },
      label: "gone",
      color: "",
    });
    t = 2000;
    store2.remove(ME, "gone");
    expect(store.list()).toHaveLength(1);
    expect(store2.list()).toHaveLength(0);
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
    expect(fc.features[0]!.properties.id).toBe("id-1");
  });
});

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

  it("throws when editing an already-deleted feature", () => {
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
    expect(() => store.update(ME, "id-1", { label: "x" })).toThrow(/deleted/i);
  });

  it("remove is idempotent: a second remove does not bump updatedAt", () => {
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
    t = 3000;
    const second = store.remove(ME, "id-1");
    expect(second.properties.updatedAt).toBe(2000);
  });

  it("throws when deleting a missing feature", () => {
    const store = makeStore();
    expect(() => store.remove(ME, "nope")).toThrow(/not found/i);
  });

  it("update preserves immutable fields (id, createdAt, authorDeviceId, kind)", () => {
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "id-1" });
    const created = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "old",
      color: "",
    });
    t = 2000;
    const updated = store.update(ME, "id-1", { label: "new" });
    expect(updated.properties.id).toBe(created.properties.id);
    expect(updated.properties.createdAt).toBe(1000);
    expect(updated.properties.authorDeviceId).toBe("dev-me");
    expect(updated.properties.kind).toBe("marker");
  });
});

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

  it("applyDelta inserts a net-new external feature", () => {
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

  it("applyDelta lets a newer external version overwrite an older local one", () => {
    let t = 1000;
    const store = new FeatureStore({ now: () => t, newId: () => "ext" });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "local-old",
      color: "",
    });
    store.applyDelta([externalFeature({ id: "ext", updatedAt: 9000, label: "external-newest" })]);
    expect(store.getRaw("ext")!.properties.label).toBe("external-newest");
  });

  it("featuresFor includes tombstones", () => {
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
    const result = store.featuresFor(["id-1"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.properties.deleted).toBe(true);
  });

  it("applyDelta merges an inbound tombstone, removing the feature from list()", () => {
    const store = new FeatureStore({ now: () => 1000, newId: () => "ext" });
    store.applyDelta([externalFeature({ id: "ext", updatedAt: 100, deleted: false })]);
    expect(store.list()).toHaveLength(1);
    store.applyDelta([externalFeature({ id: "ext", updatedAt: 200, deleted: true })]);
    expect(store.list()).toHaveLength(0);
  });
});

describe("FeatureStore onChange", () => {
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

  it("a second remove on an already-deleted feature does not notify", () => {
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
    const seen: string[][] = [];
    store.onChange((ids) => seen.push([...ids]));
    t = 3000;
    store.remove(ME, "id-1"); // no-op: already deleted
    expect(seen).toEqual([]);
  });

  it("applyDelta with an empty array does not notify", () => {
    const store = makeStore();
    const seen: string[][] = [];
    store.onChange((ids) => seen.push([...ids]));
    store.applyDelta([]);
    expect(seen).toEqual([]);
  });
});
