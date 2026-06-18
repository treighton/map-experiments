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

describe("SyncSession live broadcast", () => {
  it("propagates a local edit made after the handshake", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();

    const f = storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "live",
      color: "",
    });
    expect(storeB.getRaw(f.properties.id)?.properties.label).toBe("live");
  });

  it("does not rebroadcast a remote-origin change (no echo loop)", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();

    // Wrap connB.send to count messages B emits after handshake.
    let bSends = 0;
    const origSend = connB.send.bind(connB);
    (connB as unknown as { send: (d: string) => void }).send = (d: string) => {
      bSends++;
      origSend(d);
    };

    // A creates live -> B receives it as remote -> B must NOT send anything back.
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "live",
      color: "",
    });
    expect(bSends).toBe(0);
  });

  it("stops broadcasting after stop()", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    const sessionA = new SyncSession(storeA, connA);
    const sessionB = new SyncSession(storeB, connB);
    sessionA.start();
    sessionB.start();
    sessionA.stop();

    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "after-stop",
      color: "",
    });
    // A stopped broadcasting, so B should not have received it.
    expect(storeB.list().some((feat) => feat.properties.label === "after-stop")).toBe(false);
  });
});

describe("SyncSession delete + termination", () => {
  it("propagates a delete (tombstone) to the peer", () => {
    const [connA, connB] = connectionPair();
    let tA = 1;
    const storeA = new FeatureStore({ now: () => tA, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    new SyncSession(storeA, connA).start();
    new SyncSession(storeB, connB).start();

    // A creates then deletes a feature live.
    tA = 2;
    const f = storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "doomed",
      color: "",
    });
    tA = 3;
    storeA.remove(A, f.properties.id);

    // B must see the tombstone: excluded from list(), but getRaw shows deleted.
    expect(storeB.list().some((x) => x.properties.id === f.properties.id)).toBe(false);
    expect(storeB.getRaw(f.properties.id)?.properties.deleted).toBe(true);
  });

  it("handshake terminates (no infinite re-offer loop)", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    storeA.create(A, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "a",
      color: "",
    });
    storeB.create(B, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [2, 2] },
      label: "b",
      color: "",
    });

    // Construct both sessions first so both are listening before either fires.
    const sessionA = new SyncSession(storeA, connA);
    const sessionB = new SyncSession(storeB, connB);

    // Count total messages crossing the wire; a re-offer loop would be unbounded.
    let total = 0;
    const wrap = (conn: typeof connA) => {
      const orig = conn.send.bind(conn);
      (conn as unknown as { send: (d: string) => void }).send = (d: string) => {
        total++;
        if (total > 100) throw new Error("handshake did not terminate");
        orig(d);
      };
    };
    wrap(connA);
    wrap(connB);

    sessionA.start();
    sessionB.start();

    expect(storeA.toGeoJSON()).toEqual(storeB.toGeoJSON());
    expect(total).toBeLessThan(100); // settled in a small bounded number of messages
  });

  it("a stopped session ignores further inbound messages", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    const sessionA = new SyncSession(storeA, connA);
    new SyncSession(storeB, connB).start();
    sessionA.start();
    sessionA.stop();

    // B creates after A stopped; B will broadcast an upsert, but A (stopped) must ignore it.
    storeB.create(B, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [7, 7] },
      label: "after-a-stopped",
      color: "",
    });
    expect(storeA.list().some((x) => x.properties.label === "after-a-stopped")).toBe(false);
  });
});

describe("SyncSession inbound validation", () => {
  it("drops a poison feature in an inbound upsert without corrupting the store", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const sessionA = new SyncSession(storeA, connA);
    sessionA.start();

    // Peer B sends a raw upsert containing one valid feature and one poison
    // feature (non-finite updatedAt — the LWW poison case). The valid one must
    // apply; the poison one must be dropped; the store stays consistent.
    const valid = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: {
        id: "good",
        author: "B",
        authorDeviceId: "dev-b",
        createdAt: 10,
        updatedAt: 10,
        deleted: false,
        kind: "marker",
        label: "ok",
        color: "",
      },
    };
    const poison = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [3, 4] },
      properties: {
        id: "bad",
        author: "B",
        authorDeviceId: "dev-b",
        createdAt: 10,
        updatedAt: Number.NaN, // poison: would corrupt digest/LWW
        deleted: false,
        kind: "marker",
        label: "nope",
        color: "",
      },
    };
    connB.send(JSON.stringify({ type: "upsert", features: [valid, poison] }));

    // Valid feature applied; poison dropped; digest has no NaN.
    expect(storeA.getRaw("good")?.properties.label).toBe("ok");
    expect(storeA.getRaw("bad")).toBeUndefined();
    const digest = storeA.digest();
    expect(Object.values(digest).every((ts) => Number.isFinite(ts))).toBe(true);
  });

  it("ignores a fully-malformed inbound message and keeps applying later valid ones", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    new SyncSession(storeA, connA).start();

    connB.send("{ totally broken");
    // A valid upsert after the broken one still applies — connection survived.
    const valid = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: {
        id: "later",
        author: "B",
        authorDeviceId: "dev-b",
        createdAt: 5,
        updatedAt: 5,
        deleted: false,
        kind: "marker",
        label: "survived",
        color: "",
      },
    };
    connB.send(JSON.stringify({ type: "upsert", features: [valid] }));
    expect(storeA.getRaw("later")?.properties.label).toBe("survived");
  });
});

describe("SyncSession symmetric handshake", () => {
  it("a single start() reconciles both directions (peer pulls without starting)", () => {
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

    // Construct BOTH sessions, but only ONE calls start().
    const sessionA = new SyncSession(storeA, connA);
    new SyncSession(storeB, connB); // B never calls start()
    sessionA.start();

    // Both directions reconciled: A has B's feature AND B has A's feature.
    expect(storeA.getRaw("b1")?.properties.label).toBe("from-b");
    expect(storeB.getRaw("a1")?.properties.label).toBe("from-a");
  });
});

describe("SyncSession relay and onInbound", () => {
  it("relay() pushes an upsert to the peer even for features not in this store", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 1, newId: () => "b1" });
    new SyncSession(storeB, connB); // B applies what it receives
    const sessionA = new SyncSession(storeA, connA);

    const feature = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [9, 9] as [number, number] },
      properties: {
        id: "relayed",
        author: "X",
        authorDeviceId: "dev-x",
        createdAt: 5,
        updatedAt: 5,
        deleted: false,
        kind: "marker" as const,
        label: "via-relay",
        color: "",
      },
    };
    sessionA.relay([feature]);
    expect(storeB.getRaw("relayed")?.properties.label).toBe("via-relay");
  });

  it("relay() is a no-op on empty features", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    let bGot = 0;
    connB.onMessage(() => bGot++);
    const sessionA = new SyncSession(storeA, connA);
    sessionA.relay([]);
    expect(bGot).toBe(0);
  });

  it("a stopped session relays nothing", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    let bGot = 0;
    connB.onMessage(() => bGot++);
    const sessionA = new SyncSession(storeA, connA);
    sessionA.stop();
    const feature = {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [9, 9] as [number, number] },
      properties: {
        id: "x",
        author: "X",
        authorDeviceId: "dev-x",
        createdAt: 5,
        updatedAt: 5,
        deleted: false,
        kind: "marker" as const,
        label: "",
        color: "",
      },
    };
    sessionA.relay([feature]);
    expect(bGot).toBe(0);
  });

  it("fires onInbound after applying an inbound upsert", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const inbound: string[][] = [];
    new SyncSession(storeA, connA, {
      onInbound: (features, kind) => inbound.push([kind, ...features.map((f) => f.properties.id)]),
    });
    connB.send(
      JSON.stringify({
        type: "upsert",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [1, 2] },
            properties: {
              id: "in1",
              author: "B",
              authorDeviceId: "dev-b",
              createdAt: 3,
              updatedAt: 3,
              deleted: false,
              kind: "marker",
              label: "",
              color: "",
            },
          },
        ],
      }),
    );
    expect(storeA.getRaw("in1")).toBeDefined();
    expect(inbound).toEqual([["upsert", "in1"]]);
  });

  it("reports kind 'features' for an inbound handshake features message", () => {
    const [connA, connB] = connectionPair();
    const storeA = new FeatureStore({ now: () => 1, newId: () => "a1" });
    const seen: string[] = [];
    new SyncSession(storeA, connA, {
      onInbound: (_features, kind) => seen.push(kind),
    });
    connB.send(
      JSON.stringify({
        type: "features",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [1, 2] },
            properties: {
              id: "h1",
              author: "B",
              authorDeviceId: "dev-b",
              createdAt: 3,
              updatedAt: 3,
              deleted: false,
              kind: "marker",
              label: "",
              color: "",
            },
          },
        ],
      }),
    );
    expect(seen).toEqual(["features"]);
  });
});
