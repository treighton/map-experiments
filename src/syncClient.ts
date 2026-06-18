import type { FeatureStore } from "./featureStore.js";
import type { Connection } from "./connection.js";
import { SyncSession } from "./syncSession.js";

export type TimerHandle = number;

export interface SyncClientDeps {
  store: FeatureStore;
  /** Factory that creates a fresh Connection for each (re)connect attempt. */
  connect: () => Connection;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  /** Jitter source in [0, 1). */
  random: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Maintains a sync connection to a peer with auto-reconnect. Builds a fresh
 * SyncSession per connection. On disconnect, reconnects with capped exponential
 * backoff + jitter (all timing/randomness injected for deterministic tests).
 */
export class SyncClient {
  private readonly store: FeatureStore;
  private readonly connect: () => Connection;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  private conn: Connection | null = null;
  private session: SyncSession | null = null;
  private attempt = 0;
  private reconnectTimer: TimerHandle | null = null;
  private intentionalStop = false;

  constructor(deps: SyncClientDeps) {
    this.store = deps.store;
    this.connect = deps.connect;
    this.setTimer = deps.setTimer;
    this.clearTimer = deps.clearTimer;
    this.random = deps.random;
    this.baseDelayMs = deps.baseDelayMs ?? 1000;
    this.maxDelayMs = deps.maxDelayMs ?? 30000;
  }

  start(): void {
    this.attempt = 0;
    this.intentionalStop = false;
    this.connectNow();
  }

  stop(): void {
    this.intentionalStop = true;
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.session?.stop();
    this.conn?.close();
    this.session = null;
    this.conn = null;
  }

  private connectNow(): void {
    const conn = this.connect();
    this.conn = conn;
    const session = new SyncSession(this.store, conn);
    this.session = session;

    let started = false;
    const startOnce = () => {
      if (started) return;
      started = true;
      // NOTE: backoff resets on every successful open, not on a "stable" open.
      // A connection that flaps (opens then immediately drops) will keep
      // reconnecting at ~baseDelayMs rather than backing off. Acceptable for v1
      // (in-memory transport). TODO(real-transport): reset only after the
      // handshake completes (first inbound message) to protect a flapping peer.
      this.attempt = 0;
      session.start();
    };

    conn.onOpen(startOnce);
    conn.onClose(() => this.onDisconnect());

    // In-memory pairs don't auto-fire onOpen, so start the handshake now.
    // TODO(real-transport): a real WebSocket is not yet open here, so calling
    // session.start() immediately would send the digest into a CONNECTING socket
    // and lose it (and the `started` guard would then swallow the real onOpen).
    // For an async adapter, drop this immediate call and rely on onOpen, or add
    // an isOpen() check to the Connection interface.
    startOnce();
  }

  private onDisconnect(): void {
    this.session?.stop();
    this.session = null;
    this.conn = null;
    if (this.intentionalStop) return;
    const delay = this.nextDelay();
    this.attempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connectNow();
    }, delay);
  }

  private nextDelay(): number {
    const capped = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempt);
    // Half-jitter: 50–100% of the capped delay.
    return capped * (0.5 + 0.5 * this.random());
  }
}
