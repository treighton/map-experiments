import type {
  SarFeature,
  FeatureKind,
  Geometry,
  FeatureCollection,
} from "./types.js";
import { newId as defaultNewId } from "./uuid.js";

export interface Identity {
  callsign: string;
  deviceId: string;
}

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
    return f;
  }

  /** All features that have not been tombstoned (deleted). */
  list(): SarFeature[] {
    return [...this.features.values()].filter((f) => !f.properties.deleted);
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
    return next;
  }

  /** Tombstone a feature you authored (soft delete). Throws if missing or not yours. */
  remove(identity: Identity, id: string): SarFeature {
    const current = this.requireOwned(identity, id);
    const next: SarFeature = {
      ...current,
      properties: {
        ...current.properties,
        deleted: true,
        updatedAt: this.now(),
      },
    };
    this.features.set(id, next);
    return next;
  }
}
