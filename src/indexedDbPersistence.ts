import type { SarFeature } from "./types.js";
import type { FeatureStore } from "./featureStore.js";
import { WriteScheduler } from "./writeScheduler.js";

const STORE_NAME = "features";

export interface PersistenceTimerDeps {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (h: number) => void;
  delayMs?: number;
  maxBatch?: number;
}

/** Promisify an IDBRequest. */
function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persists FeatureStore features to IndexedDB. The only unit that touches
 * IndexedDB. Hydrates via the store's applyDelta (CRDT merge path) and writes
 * changed features in debounced batched transactions.
 */
export class IndexedDbPersistence {
  private scheduler: WriteScheduler;
  private boundStore: FeatureStore | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  private constructor(
    private db: IDBDatabase,
    timerDeps: PersistenceTimerDeps,
  ) {
    this.scheduler = new WriteScheduler({
      setTimer: timerDeps.setTimer,
      clearTimer: timerDeps.clearTimer,
      flushFn: (ids) => this.writeBatch(ids),
      delayMs: timerDeps.delayMs,
      maxBatch: timerDeps.maxBatch,
    });
  }

  static async open(
    dbName: string,
    timerDeps: PersistenceTimerDeps,
  ): Promise<IndexedDbPersistence> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "properties.id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return new IndexedDbPersistence(db, timerDeps);
  }

  /** Read all persisted features and merge them into the store via applyDelta. */
  async load(store: FeatureStore): Promise<void> {
    const tx = this.db.transaction(STORE_NAME, "readonly");
    const objStore = tx.objectStore(STORE_NAME);
    const records = await reqAsPromise<SarFeature[]>(
      objStore.getAll() as IDBRequest<SarFeature[]>,
    );
    store.applyDelta(records);
  }

  /**
   * Subscribe to the store and persist changes. Call load() BEFORE attach() so
   * hydration does not echo loaded features straight back into writes. Returns an
   * unsubscribe that also detaches.
   */
  attach(store: FeatureStore): () => void {
    this.boundStore = store;
    const off = store.onChange((ids) => {
      for (const id of ids) this.scheduler.markDirty(id);
    });
    return () => {
      off();
      this.boundStore = null;
    };
  }

  /** Force any pending debounced writes to complete. */
  async flush(): Promise<void> {
    this.scheduler.flush();
    await this.inFlight;
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  /** Write the current value of each id in one readwrite transaction. */
  private writeBatch(ids: readonly string[]): Promise<void> {
    const store = this.boundStore;
    if (!store) return Promise.resolve();
    const run = (async () => {
      const tx = this.db.transaction(STORE_NAME, "readwrite");
      const objStore = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        const feature = store.getRaw(id);
        if (feature) objStore.put(feature);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
      }).catch((err) => {
        // Re-mark dirty for retry on the next flush; do not drop data.
        console.error("IndexedDbPersistence write failed, will retry:", err);
        for (const id of ids) this.scheduler.markDirty(id);
      });
    })();
    this.inFlight = run;
    return run;
  }
}
