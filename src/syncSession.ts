import type { FeatureStore, ChangeOrigin } from "./featureStore.js";
import type { Connection } from "./connection.js";
import { parseMessage, idsNeeded, type SyncMessage } from "./syncProtocol.js";

/**
 * Drives the sync protocol over one Connection against one FeatureStore.
 * On start() it sends its digest; it answers digest->need, need->features,
 * features/upsert->applyDelta. Live upsert broadcast is added separately.
 */
export class SyncSession {
  private stopped = false;
  private offChange: () => void;

  constructor(
    private store: FeatureStore,
    private conn: Connection,
  ) {
    this.conn.onMessage((data) => this.handle(data));
    this.offChange = this.store.onChange((ids, origin) =>
      this.onLocalChange(ids, origin),
    );
  }

  /** Begin the handshake by sending our digest. */
  start(): void {
    this.send({ type: "digest", entries: this.store.digest() });
  }

  /** Broadcast only local-origin edits; remote-origin changes are terminal. */
  private onLocalChange(ids: readonly string[], origin: ChangeOrigin): void {
    if (this.stopped || origin !== "local") return;
    const features = this.store.featuresFor(ids);
    if (features.length > 0) this.send({ type: "upsert", features });
  }

  /**
   * End the session: stop broadcasting local edits AND stop applying inbound
   * messages. The connection itself is owned by the caller, who should close()
   * it after stop().
   */
  stop(): void {
    this.stopped = true;
    this.offChange();
  }

  private send(msg: SyncMessage): void {
    this.conn.send(JSON.stringify(msg));
  }

  private handle(data: string): void {
    if (this.stopped) return;
    const msg = parseMessage(data);
    if (!msg) {
      console.error("SyncSession: dropping malformed message");
      return;
    }
    switch (msg.type) {
      case "digest": {
        const need = idsNeeded(this.store.digest(), msg.entries);
        if (need.length > 0) this.send({ type: "need", ids: need });
        break;
      }
      case "need": {
        const features = this.store.featuresFor(msg.ids);
        if (features.length > 0) this.send({ type: "features", features });
        break;
      }
      case "features": {
        this.store.applyDelta(msg.features);
        break;
      }
      case "upsert": {
        this.store.applyDelta(msg.features);
        break;
      }
    }
  }
}
