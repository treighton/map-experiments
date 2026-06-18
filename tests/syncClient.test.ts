import { describe, it, expect } from "vitest";
import { SyncClient } from "../src/syncClient.js";
import { FeatureStore } from "../src/featureStore.js";
import { connectionPair } from "../src/connection.js";
import { SyncSession } from "../src/syncSession.js";
import type { InMemoryConnection } from "../src/connection.js";

const ME = { callsign: "Mike", deviceId: "dev-me" };

/** A fake timer that captures scheduled callbacks so tests can fire them. */
class FakeTimer {
  private fns = new Map<number, () => void>();
  private next = 1;
  lastDelay = 0;
  setTimer = (fn: () => void, ms: number): number => {
    this.lastDelay = ms;
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
  get armed(): number {
    return this.fns.size;
  }
}

describe("SyncClient connect", () => {
  it("connects and converges with a peer via handshake", () => {
    const serverStore = new FeatureStore({ now: () => 1, newId: () => "srv-1" });
    serverStore.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 1] },
      label: "on-server",
      color: "",
    });

    const timer = new FakeTimer();
    const clientStore = new FeatureStore({ now: () => 2, newId: () => "c1" });

    // connect() factory: build a pair, attach a server-side session to one end,
    // return the other end to the client.
    const connect = (): InMemoryConnection => {
      const [clientConn, serverConn] = connectionPair();
      const serverSession = new SyncSession(serverStore, serverConn);
      serverSession.start();
      return clientConn;
    };

    const client = new SyncClient({
      store: clientStore,
      connect,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
      random: () => 0.5,
    });
    client.start();

    expect(clientStore.getRaw("srv-1")?.properties.label).toBe("on-server");
    client.stop();
  });
});
