import type { FeatureStore } from "./featureStore.js";
import type { Connection } from "./connection.js";
import type { SarFeature } from "./types.js";
import { SyncSession } from "./syncSession.js";

/**
 * Relays edits among many connected clients through one shared FeatureStore.
 * Each accepted connection gets a SyncSession; a live inbound upsert on one
 * session is relayed to all OTHER sessions (attributed, so it never echoes to
 * its origin). Handshake "features" responses are NOT relayed — they would
 * re-fan a joining client's existing features to every sibling (idempotent via
 * LWW, but wasteful). Transport-agnostic: feed it Connections via accept(); real
 * WebSocket listening is a thin out-of-scope adapter.
 */
export class SyncServer {
  private sessions = new Set<SyncSession>();

  constructor(private store: FeatureStore) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Intake a new client connection: register a session and wire its lifecycle.
   *
   * Handshake ordering note: in-memory pairs (used in tests) deliver messages
   * synchronously, so the server-side session's start() must fire AFTER the
   * client-side session has registered its message handler — otherwise the
   * server's initial digest would arrive before the client is listening and be
   * silently dropped, preventing state catch-up for late-joining clients.
   *
   * Strategy: intercept the connection's onMessage registration so the server
   * fires start() just before it processes the client's very first message.
   * At that moment the client is guaranteed to have its handler registered
   * (it sent a message, so its SyncSession constructor has already run).
   * startOnce is idempotent — the onOpen fallback covers real async transports
   * where the connection opens before any message arrives.
   */
  accept(conn: Connection): void {
    let started = false;
    // `session` is declared with const below; the closure captures the binding,
    // which will be initialised before any inbound message can arrive.
    // eslint-disable-next-line prefer-const
    let sessionRef: SyncSession | undefined;
    const startOnce = () => {
      if (started) return;
      started = true;
      sessionRef!.start();
    };

    // Wrap onMessage so the server fires start() on the first inbound message,
    // guaranteeing the client's handler is already registered when the server's
    // digest hits the wire.
    const origOnMessage = conn.onMessage.bind(conn);
    let intercepted = false;
    conn.onMessage = (handler: (data: string) => void) => {
      origOnMessage((data: string) => {
        if (!intercepted) {
          intercepted = true;
          startOnce();
        }
        handler(data);
      });
    };

    const session = new SyncSession(this.store, conn, {
      onInbound: (features, kind) => {
        // Only relay live upserts; handshake features pulls stay local.
        if (kind === "upsert") this.relayFrom(session, features);
      },
    });
    sessionRef = session;
    this.sessions.add(session);

    // Fallback for real async-opening transports where onOpen fires before
    // any message arrives (startOnce is idempotent).
    conn.onOpen(startOnce);
    conn.onClose(() => {
      session.stop();
      this.sessions.delete(session);
    });
  }

  /** Forward a live inbound delta to every session except its origin. */
  private relayFrom(origin: SyncSession, features: SarFeature[]): void {
    for (const session of this.sessions) {
      if (session !== origin) session.relay(features);
    }
  }
}
