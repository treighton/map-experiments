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
