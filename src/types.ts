export type FeatureKind = "marker" | "track" | "line" | "polygon";

export type Geometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] };

export interface FeatureProperties {
  id: string;
  author: string;
  authorDeviceId: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  kind: FeatureKind;
  label: string;
  color: string;
}

export interface SarFeature {
  type: "Feature";
  geometry: Geometry;
  properties: FeatureProperties;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: SarFeature[];
}

/** Map of feature id -> updatedAt, exchanged during sync reconcile. */
export type Digest = Record<string, number>;

export interface Identity {
  callsign: string;
  deviceId: string;
}
