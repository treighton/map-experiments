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
   * Intake a new client connection. The client drives the handshake: when it
   * sends its digest, this session replies symmetrically (advertising the shared
   * store's digest), so the client catches up existing state. The server does not
   * call start() — the symmetric digest exchange handles both directions.
   */
  accept(conn: Connection): void {
    const session = new SyncSession(this.store, conn, {
      onInbound: (features, kind) => {
        // Only relay live upserts; handshake features pulls stay local.
        if (kind === "upsert") this.relayFrom(session, features);
      },
    });
    this.sessions.add(session);

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
