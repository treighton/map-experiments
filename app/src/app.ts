import {
  FeatureStore,
  IndexedDbPersistence,
  SyncClient,
  BrowserWebSocketConnection,
  loadOrCreateIdentity,
  type Identity,
} from "@sartools/feature-store";
import { createMapStore, type MapStore } from "./mapStore.js";

export interface AppContext {
  store: FeatureStore;
  mapStore: MapStore;
  syncClient: SyncClient;
  setCallsign: (callsign: string) => Identity;
  getIdentity: () => Identity | null;
  destroy: () => void;
}

const WS_URL =
  (import.meta.env.VITE_SYNC_URL as string | undefined) ?? "ws://localhost:8787";

export async function createAppContext(): Promise<AppContext> {
  const store = new FeatureStore();

  let detachPersistence: (() => void) | null = null;
  let persistence: IndexedDbPersistence | null = null;
  try {
    persistence = await IndexedDbPersistence.open("sar-map", {
      setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimer: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
    });
    await persistence.load(store);
    detachPersistence = persistence.attach(store);
  } catch (err) {
    console.error("Persistence unavailable, continuing in-memory:", err);
  }

  const syncClient = new SyncClient({
    store,
    connect: () => new BrowserWebSocketConnection(WS_URL),
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
  });
  // start() begins connecting; the first inbound message can only arrive
  // asynchronously after onOpen, by which point createMapStore has run.
  syncClient.start();

  const mapStore = createMapStore(store);

  let identity: Identity | null = null;

  return {
    store,
    mapStore,
    syncClient,
    setCallsign: (callsign: string) => {
      identity = loadOrCreateIdentity(window.localStorage, callsign);
      return identity;
    },
    getIdentity: () => {
      if (identity) return identity;
      // loadOrCreateIdentity writes the callsign under "sar.callsign"; read the
      // same key to detect a returning user.
      const existing = window.localStorage.getItem("sar.callsign");
      if (existing) {
        identity = loadOrCreateIdentity(window.localStorage, existing);
        return identity;
      }
      return null;
    },
    destroy: () => {
      detachPersistence?.();
      void persistence?.close();
      syncClient.stop();
      mapStore.destroy();
    },
  };
}
