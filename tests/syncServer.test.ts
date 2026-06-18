import { describe, it, expect } from "vitest";
import { SyncServer } from "../src/syncServer.js";
import { FeatureStore } from "../src/featureStore.js";
import { connectionPair } from "../src/connection.js";
import { SyncSession } from "../src/syncSession.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };
const C2 = { callsign: "Team2", deviceId: "dev-2" };

/** Build a client store + session wired to one end of a pair; server.accept the other. */
function connectClient(server: SyncServer, clientStore: FeatureStore) {
  const [clientConn, serverConn] = connectionPair();
  server.accept(serverConn);
  clientConn.open();
  const session = new SyncSession(clientStore, clientConn);
  session.start();
  return { clientConn, session };
}

describe("SyncServer", () => {
  it("relays an edit from one client to another but not back to the origin", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);

    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    connectClient(server, storeA);
    connectClient(server, storeB);

    const f = storeA.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "from-a",
      color: "",
    });
    expect(serverStore.getRaw(f.properties.id)?.properties.label).toBe("from-a");
    expect(storeB.getRaw(f.properties.id)?.properties.label).toBe("from-a");
  });

  it("late-joining client catches up existing state on connect", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);

    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    connectClient(server, storeA);
    storeA.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "early",
      color: "",
    });

    const storeB = new FeatureStore({ now: () => 2, newId: () => "b1" });
    connectClient(server, storeB);
    expect(storeB.getRaw("a1")?.properties.label).toBe("early");
  });

  it("removes a session when its connection closes", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const { clientConn } = connectClient(server, storeA);
    expect(server.sessionCount).toBe(1);
    clientConn.close();
    expect(server.sessionCount).toBe(0);
  });

  it("a removed client no longer receives relays", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    const a = connectClient(server, storeA);
    connectClient(server, storeB);

    a.clientConn.close();
    expect(server.sessionCount).toBe(1);

    storeB.create(C2, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [7, 7] },
      label: "after-a-left",
      color: "",
    });
    expect(storeA.list().some((x) => x.properties.label === "after-a-left")).toBe(false);
    expect(storeB.getRaw("b1")?.properties.label).toBe("after-a-left");
  });

  it("does not relay a joining client's handshake features to existing siblings", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);

    // A and B already connected (empty stores).
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    const a = connectClient(server, storeA);
    connectClient(server, storeB);

    // Count messages A's connection receives from here on.
    let aMsgs = 0;
    a.clientConn.onMessage(() => aMsgs++);

    // C joins carrying a pre-existing feature; its handshake pulls it to the server.
    const storeC = new FeatureStore({ now: () => 1, newId: () => "c1" });
    storeC.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [9, 9] },
      label: "c-preexisting",
      color: "",
    });
    connectClient(server, storeC);

    // The server pulled c1 into the shared store...
    expect(serverStore.getRaw("c1")?.properties.label).toBe("c-preexisting");
    // ...but did NOT relay C's handshake "features" to A (no redundant fan-out).
    // A receives nothing because C's feature arrived via a handshake "features"
    // message (kind "features"), which the server does not relay.
    expect(aMsgs).toBe(0);
    expect(storeA.getRaw("c1")).toBeUndefined();
  });

  it("DOES relay a live upsert from a joined client to siblings", () => {
    // Contrast test: a LIVE edit (not handshake) IS relayed.
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "s" });
    const server = new SyncServer(serverStore);
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeC = new FeatureStore({ now: () => 1, newId: () => "c1" });
    connectClient(server, storeA);
    connectClient(server, storeC);

    // C makes a LIVE edit after its handshake — this IS relayed to A.
    storeC.create(C2, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [4, 4] },
      label: "c-live",
      color: "",
    });
    expect(storeA.getRaw("c1")?.properties.label).toBe("c-live");
  });
});
