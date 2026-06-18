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
});
