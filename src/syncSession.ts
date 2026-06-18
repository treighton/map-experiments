import type { FeatureStore, ChangeOrigin } from "./featureStore.js";
import type { Connection } from "./connection.js";
import { parseMessage, idsNeeded, type SyncMessage } from "./syncProtocol.js";
import type { SarFeature } from "./types.js";

export interface SyncSessionOptions {
  /**
   * Called after an inbound features/upsert is applied. `kind` distinguishes a
   * handshake "features" response from a live "upsert"; the server relays only
   * "upsert" to avoid re-fanning handshake pulls to every sibling.
   */
  onInbound?: (features: SarFeature[], kind: "features" | "upsert") => void;
}

/**
 * Drives the sync protocol over one Connection against one FeatureStore.
 * On start() it sends its digest; it answers digest->need, need->features,
 * features/upsert->applyDelta. Live upsert broadcast is added separately.
 */
export class SyncSession {
  private stopped = false;
  private digestSent = false;
  /**
   * True if we received the peer's digest before we had ever sent our own. When
   * this is true, the peer definitely saw our first digest (or we hadn't sent one
   * yet), so no re-send is needed. When false AND digestSent is true, our first
   * send may have gone to an empty channel (e.g., SyncClient factory called
   * serverSession.start() before the client session was wired), so we allow one
   * additional re-send upon receiving the peer's first digest.
   */
  private receivedDigestFirst = false;
  /** Guards the one-time re-send so we never re-send more than twice total. */
  private digestResentOnce = false;
  private offChange: () => void;
  private onInbound?: (features: SarFeature[], kind: "features" | "upsert") => void;

  constructor(
    private store: FeatureStore,
    private conn: Connection,
    opts: SyncSessionOptions = {},
  ) {
    this.onInbound = opts.onInbound;
    this.conn.onMessage((data) => this.handle(data));
    this.offChange = this.store.onChange((ids, origin) =>
      this.onLocalChange(ids, origin),
    );
  }

  /** Begin the handshake by sending our digest. Idempotent (sent at most once). */
  start(): void {
    this.sendDigest();
  }

  private sendDigest(): void {
    if (!this.digestSent) {
      // First send — always allowed.
      this.digestSent = true;
      this.send({ type: "digest", entries: this.store.digest() });
      return;
    }
    // Already sent. Allow one re-send only if our first send may have been
    // dropped (peer wasn't listening yet): that is, we sent before receiving
    // any digest from the peer AND we haven't resent yet.
    if (!this.receivedDigestFirst && !this.digestResentOnce) {
      this.digestResentOnce = true;
      this.send({ type: "digest", entries: this.store.digest() });
    }
  }

  /**
   * Push features to the peer as an upsert WITHOUT the local-only onChange gate.
   * Used by the server to forward remote-origin deltas to other clients. No-op if
   * stopped or empty.
   */
  relay(features: readonly SarFeature[]): void {
    if (this.stopped || features.length === 0) return;
    this.send({ type: "upsert", features: features as SarFeature[] });
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
        // Record whether we got the peer's digest before we had sent our own.
        if (!this.digestSent) this.receivedDigestFirst = true;
        const need = idsNeeded(this.store.digest(), msg.entries);
        if (need.length > 0) this.send({ type: "need", ids: need });
        // Reply symmetrically so a single peer start() drives both directions.
        // Guarded to at most two sends total: the initial proactive send AND at
        // most one re-send if that proactive send was lost (peer not yet listening).
        this.sendDigest();
        break;
      }
      case "need": {
        const features = this.store.featuresFor(msg.ids);
        if (features.length > 0) this.send({ type: "features", features });
        break;
      }
      case "features": {
        this.store.applyDelta(msg.features);
        this.onInbound?.(msg.features, "features");
        break;
      }
      case "upsert": {
        this.store.applyDelta(msg.features);
        this.onInbound?.(msg.features, "upsert");
        break;
      }
    }
  }
}
