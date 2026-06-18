import { describe, it, expect } from "vitest";
import { FeatureStore } from "../src/featureStore.js";

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
