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
