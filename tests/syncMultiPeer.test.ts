import { describe, it, expect } from "vitest";
import { SyncClient } from "../src/syncClient.js";
import { SyncServer } from "../src/syncServer.js";
import { FeatureStore } from "../src/featureStore.js";
import { connectionPair } from "../src/connection.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

/** A no-op timer (we don't exercise reconnect here) and fixed jitter. */
function noopTimerDeps() {
  return {
    setTimer: (_fn: () => void, _ms: number) => 0,
    clearTimer: (_h: number) => {},
    random: () => 0.5,
  };
}

describe("multi-peer convergence", () => {
  it("two clients through one server converge to identical state", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const server = new SyncServer(serverStore);

    let tA = 10;
    let tB = 10;
    let nA = 0;
    let nB = 0;
    const storeA = new FeatureStore({ now: () => tA, newId: () => `a-${++nA}` });
    const storeB = new FeatureStore({ now: () => tB, newId: () => `b-${++nB}` });

    const connectA = () => {
      const [clientConn, serverConn] = connectionPair();
      server.accept(serverConn);
      clientConn.open();
      return clientConn;
    };
    const connectB = () => {
      const [clientConn, serverConn] = connectionPair();
      server.accept(serverConn);
      clientConn.open();
      return clientConn;
    };

    const clientA = new SyncClient({ store: storeA, connect: connectA, ...noopTimerDeps() });
    const clientB = new SyncClient({ store: storeB, connect: connectB, ...noopTimerDeps() });
    clientA.start();
    clientB.start();

    // Interleaved edits on both clients.
    tA = 20;
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "a-one",
      color: "",
    });
    tB = 21;
    storeB.create(B, {
      kind: "line",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      label: "b-one",
      color: "",
    });
    tA = 30;
    const aTwo = storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [2, 2] },
      label: "a-two",
      color: "",
    });
    tA = 31;
    storeA.remove(A, aTwo.properties.id);

    // All three stores converge.
    expect(storeA.toGeoJSON()).toEqual(storeB.toGeoJSON());
    expect(storeA.toGeoJSON()).toEqual(serverStore.toGeoJSON());
    expect(storeA.list()).toHaveLength(2); // a-one, b-one (a-two deleted)

    clientA.stop();
    clientB.stop();
  });
});
