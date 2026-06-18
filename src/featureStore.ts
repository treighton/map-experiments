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

  list(): SarFeature[] {
    return [...this.features.values()].filter((f) => !f.properties.deleted);
  }

  toGeoJSON(): FeatureCollection {
    return { type: "FeatureCollection", features: this.list() };
  }
}
