import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { FeatureStore } from "@sartools/feature-store";
import { createMapStore } from "./mapStore.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };

function makeStore() {
  let n = 0;
  return new FeatureStore({ now: () => 1000, newId: () => `id-${++n}` });
}

describe("createMapStore", () => {
  it("exposes the current non-deleted features reactively", () => {
    const store = makeStore();
    const map = createMapStore(store);
    expect(get(map.features)).toHaveLength(0);

    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(get(map.features)).toHaveLength(1);
  });

  it("updates the store value when a feature is created", () => {
    const store = makeStore();
    const map = createMapStore(store);
    const seen: number[] = [];
    const unsub = map.features.subscribe((fs) => seen.push(fs.length));
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    unsub();
    expect(seen).toEqual([0, 1]);
  });

  it("toGeoJSON() returns a FeatureCollection snapshot", () => {
    const store = makeStore();
    const map = createMapStore(store);
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    const fc = map.toGeoJSON();
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
  });

  it("stops updating after destroy()", () => {
    const store = makeStore();
    const map = createMapStore(store);
    map.destroy();
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(get(map.features)).toHaveLength(0);
  });
});
