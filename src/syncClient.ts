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
 * Capped exponential backoff with half-jitter.
 * delay = min(maxDelayMs, baseDelayMs * 2**attempt) * (0.5 + 0.5*random),
 * i.e. 50–100% of the capped exponential delay. `random` is in [0, 1).
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: number,
): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return capped * (0.5 + 0.5 * random);
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
      session.start();
    };

    // Reset backoff only when the handshake makes PROGRESS (first inbound
    // message), not on bare open — a flapping socket that opens then drops
    // without exchanging a message keeps backing off.
    let firstInbound = true;
    conn.onMessage(() => {
      if (firstInbound) {
        firstInbound = false;
        this.attempt = 0;
      }
    });

    conn.onOpen(startOnce);
    conn.onClose(() => this.onDisconnect());

    // Start now only if already open (in-memory). A real WebSocket is CONNECTING
    // at this point, so we wait for onOpen to avoid sending the digest into a
    // not-yet-open socket.
    if (conn.isOpen()) startOnce();
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
    return backoffDelay(
      this.attempt,
      this.baseDelayMs,
      this.maxDelayMs,
      this.random(),
    );
  }
}
