import { describe, it, expect } from "vitest";
import { SyncSession } from "../src/syncSession.js";
import { connectionPair } from "../src/connection.js";
import { FeatureStore } from "../src/featureStore.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

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
    const storeA = new FeatureStore({ now: () => 1, newId: () => "x" });
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "old",
      color: "",
    });
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
    expect(() => connB.send("{not valid")).not.toThrow();
  });
});
