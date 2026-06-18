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

    // Construct BOTH sessions before starting either (ordering matters).
    const sessionA = new SyncSession(storeA, connA);
    const sessionB = new SyncSession(storeB, connB);
    sessionA.start();
    sessionB.start();

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
