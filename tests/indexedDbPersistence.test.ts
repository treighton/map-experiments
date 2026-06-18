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

/** A controllable timer: tracks the latest armed callback so a test can fire it. */
class ControllableTimer {
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
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

describe("IndexedDbPersistence debounce integration", () => {
  it("persists via the debounce timer firing (no explicit flush)", async () => {
    const timer = new ControllableTimer();
    const p = await IndexedDbPersistence.open("sar-test", {
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      delayMs: 200,
    });
    const store = new FeatureStore({ now: () => 1000, newId: () => "id-1" });
    p.attach(store);
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "via-timer",
      color: "",
    });
    // Fire the debounce timer; this triggers scheduler.flush -> writeBatch.
    timer.fire();
    // Await the in-flight write to settle.
    await p.flush();
    await p.close();

    const p2 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const reloaded = new FeatureStore({ now: () => 2000, newId: () => "id-x" });
    await p2.load(reloaded);
    expect(reloaded.getRaw("id-1")?.properties.label).toBe("via-timer");
    await p2.close();
  });

  it("persists two features changed before a single flush", async () => {
    const p = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    let n = 0;
    const store = new FeatureStore({ now: () => 1000, newId: () => `id-${++n}` });
    p.attach(store);
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "first",
      color: "",
    });
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [2, 2] },
      label: "second",
      color: "",
    });
    await p.flush();
    await p.close();

    const p2 = await IndexedDbPersistence.open("sar-test", noopTimerDeps());
    const reloaded = new FeatureStore({ now: () => 2000, newId: () => "id-x" });
    await p2.load(reloaded);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.getRaw("id-1")?.properties.label).toBe("first");
    expect(reloaded.getRaw("id-2")?.properties.label).toBe("second");
    await p2.close();
  });
});
