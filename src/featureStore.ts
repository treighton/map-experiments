import type {
  SarFeature,
  FeatureKind,
  Geometry,
  FeatureCollection,
  Digest,
  Identity,
} from "./types.js";
import { newId as defaultNewId } from "./uuid.js";
import { mergeAll } from "./merge.js";

export interface CreateInput {
  kind: FeatureKind;
  geometry: Geometry;
  label: string;
  color: string;
}

export interface StoreDeps {
  now?: () => number;
  newId?: () => string;
}

export type EditableFields = Partial<
  Pick<SarFeature["properties"], "label" | "color"> & {
    geometry: Geometry;
  }
>;

export type ChangeOrigin = "local" | "remote";
export type ChangeListener = (
  changedIds: readonly string[],
  origin: ChangeOrigin,
) => void;

/**
 * In-memory store of map features, keyed by feature id.
 *
 * Stored features are treated as immutable values: callers MUST NOT mutate a
 * feature returned by `create`, `list`, or `toGeoJSON` in place. To change a
 * feature, go through the store's edit methods (added in later tasks), which
 * produce a new feature object. The store relies on this convention rather than
 * defensive copying.
 *
 * Time and id generation are injected (`StoreDeps`) so behavior is deterministic
 * in tests.
 */
export class FeatureStore {
  private features = new Map<string, SarFeature>();
  private now: () => number;
  private newId: () => string;
  private listeners = new Set<ChangeListener>();

  constructor(deps: StoreDeps = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? defaultNewId;
  }

  create(identity: Identity, input: CreateInput): SarFeature {
    const t = this.now();
    const f: SarFeature = {
      type: "Feature",
      geometry: input.geometry,
      properties: {
        id: this.newId(),
        author: identity.callsign,
        authorDeviceId: identity.deviceId,
        createdAt: t,
        updatedAt: t,
        deleted: false,
        kind: input.kind,
        label: input.label,
        color: input.color,
      },
    };
    this.features.set(f.properties.id, f);
    this.notify([f.properties.id], "local");
    return f;
  }

  /**
   * All features that have not been tombstoned (deleted), in a stable order
   * (sorted by id) so that two converged stores produce identical output.
   */
  list(): SarFeature[] {
    return [...this.features.values()]
      .filter((f) => !f.properties.deleted)
      .sort((a, b) =>
        a.properties.id < b.properties.id ? -1 : a.properties.id > b.properties.id ? 1 : 0,
      );
  }

  /** Export non-deleted features as a GeoJSON FeatureCollection. */
  toGeoJSON(): FeatureCollection {
    return { type: "FeatureCollection", features: this.list() };
  }

  /** The raw stored feature for an id, including tombstones; undefined if unknown. */
  getRaw(id: string): SarFeature | undefined {
    return this.features.get(id);
  }

  private requireOwned(identity: Identity, id: string): SarFeature {
    const f = this.features.get(id);
    if (!f) throw new Error(`Feature not found: ${id}`);
    if (f.properties.authorDeviceId !== identity.deviceId) {
      throw new Error(`You are not the author of feature ${id}`);
    }
    return f;
  }

  /** Edit a feature you authored. Bumps updatedAt. Throws if missing or not yours. */
  update(identity: Identity, id: string, edits: EditableFields): SarFeature {
    const current = this.requireOwned(identity, id);
    if (current.properties.deleted) {
      throw new Error(`Feature ${id} has been deleted`);
    }
    const { geometry, ...propEdits } = edits;
    const next: SarFeature = {
      type: "Feature",
      geometry: geometry ?? current.geometry,
      properties: {
        ...current.properties,
        ...propEdits,
        updatedAt: this.now(),
      },
    };
    this.features.set(id, next);
    this.notify([id], "local");
    return next;
  }

  /** Tombstone a feature you authored (soft delete). Throws if missing or not yours. */
  remove(identity: Identity, id: string): SarFeature {
    const current = this.requireOwned(identity, id);
    if (current.properties.deleted) return current;
    const next: SarFeature = {
      ...current,
      properties: {
        ...current.properties,
        deleted: true,
        updatedAt: this.now(),
      },
    };
    this.features.set(id, next);
    this.notify([id], "local");
    return next;
  }

  /** id -> updatedAt for every feature, tombstones included. */
  digest(): Digest {
    const out: Digest = {};
    for (const [id, f] of this.features) out[id] = f.properties.updatedAt;
    return out;
  }

  /** Full features for the given ids, tombstones included, skipping ids unknown to this store. */
  featuresFor(ids: readonly string[]): SarFeature[] {
    const out: SarFeature[] = [];
    for (const id of ids) {
      const f = this.features.get(id);
      if (f) out.push(f);
    }
    return out;
  }

  /** Merge externally-received features (including tombstones) via LWW. No ownership check: inbound features are authored by other devices. */
  applyDelta(incoming: readonly SarFeature[]): void {
    if (incoming.length === 0) return;
    this.features = mergeAll(this.features, incoming);
    this.notify(incoming.map((f) => f.properties.id), "remote");
  }

  /**
   * Subscribe to mutations. The listener is called after each create/update/
   * remove/applyDelta with the affected ids, and can read the new state via
   * getRaw. Returns an unsubscribe function.
   *
   * Notes:
   * - For applyDelta the listener receives every incoming id, including ones
   *   where LWW kept the local version (a harmless no-op for idempotent writers).
   * - Listeners are called synchronously and MUST NOT call mutating methods on
   *   this store (create/update/remove/applyDelta); doing so causes reentrant
   *   notification.
   */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners. One throwing listener must not break others or the store. */
  private notify(changedIds: readonly string[], origin: ChangeOrigin): void {
    for (const listener of this.listeners) {
      try {
        listener(changedIds, origin);
      } catch (err) {
        console.error("FeatureStore change listener threw:", err);
      }
    }
  }
}
