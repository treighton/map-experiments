import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { createServer } from "node:net";
import { FeatureStore } from "../src/featureStore.js";
import { SyncServer } from "../src/syncServer.js";
import { WebSocketSyncServer } from "../src/webSocketSyncServer.js";
import { SyncClient } from "../src/syncClient.js";
import { NodeWebSocketConnection } from "../src/nodeWebSocketConnection.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };

/** Find a free TCP port by briefly binding to 0. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}

/** Poll until predicate() is true or timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function realTimerDeps() {
  return {
    setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
    random: () => 0.5,
  };
}

describe("WebSocket integration (real localhost socket)", () => {
  let wsServer: WebSocketSyncServer | null = null;
  const clients: SyncClient[] = [];

  afterEach(async () => {
    for (const c of clients) c.stop();
    clients.length = 0;
    if (wsServer) await wsServer.stop();
    wsServer = null;
  });

  it("a client converges with the server store over a real socket", async () => {
    const port = await getFreePort();
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const syncServer = new SyncServer(serverStore);
    wsServer = new WebSocketSyncServer(syncServer, { port });
    await wsServer.start();

    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });
    const client = new SyncClient({
      store: clientStore,
      connect: () => new NodeWebSocketConnection(new WebSocket(`ws://localhost:${port}`)),
      ...realTimerDeps(),
    });
    clients.push(client);
    client.start();

    // Wait for the handshake to establish a session on the server.
    await waitFor(() => syncServer.sessionCount === 1);

    // Create a feature on the client; it should reach the server store.
    clientStore.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [5, 5] },
      label: "over-the-wire",
      color: "",
    });

    await waitFor(() => serverStore.getRaw("c1")?.properties.label === "over-the-wire");
    expect(serverStore.getRaw("c1")?.properties.label).toBe("over-the-wire");
  });

  it("two clients converge with each other through the server over real sockets", async () => {
    const port = await getFreePort();
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv" });
    const syncServer = new SyncServer(serverStore);
    wsServer = new WebSocketSyncServer(syncServer, { port });
    await wsServer.start();

    const storeA = new FeatureStore({ now: () => 2, newId: () => "a1" });
    const storeB = new FeatureStore({ now: () => 3, newId: () => "b1" });
    const mk = (store: FeatureStore) =>
      new SyncClient({
        store,
        connect: () => new NodeWebSocketConnection(new WebSocket(`ws://localhost:${port}`)),
        ...realTimerDeps(),
      });
    const clientA = mk(storeA);
    const clientB = mk(storeB);
    clients.push(clientA, clientB);
    clientA.start();
    clientB.start();

    await waitFor(() => syncServer.sessionCount === 2);

    // A creates a feature; it should reach B via the server relay.
    storeA.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [7, 7] },
      label: "a-to-b",
      color: "",
    });

    await waitFor(() => storeB.getRaw("a1")?.properties.label === "a-to-b");
    expect(storeB.getRaw("a1")?.properties.label).toBe("a-to-b");
  });
});
