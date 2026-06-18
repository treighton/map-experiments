import type { CreateInput, FeatureKind, Geometry } from "@sartools/feature-store";

const DEFAULT_COLORS: Record<FeatureKind, string> = {
  marker: "#c1432f",
  line: "#1a73c1",
  polygon: "#1a7f37",
  track: "#7a3fc1",
};

const GEOMETRY_KIND: Record<string, FeatureKind> = {
  Point: "marker",
  LineString: "line",
  Polygon: "polygon",
};

interface DrawnFeature {
  type: "Feature";
  geometry?: { type?: string; coordinates?: unknown };
  properties?: unknown;
}

function coordsLookValid(type: string, coords: unknown): boolean {
  if (!Array.isArray(coords)) return false;
  if (type === "Point") return coords.length >= 2 && coords.every((n) => typeof n === "number");
  return coords.length > 0 && Array.isArray(coords[0]);
}

/**
 * Map a terra-draw finished GeoJSON feature to FeatureStore.create input. Returns
 * null if the geometry is missing, an unsupported type, or malformed — the caller
 * skips creating a feature in that case.
 */
export function toCreateInput(drawn: DrawnFeature): CreateInput | null {
  const geom = drawn.geometry;
  if (!geom || typeof geom.type !== "string") return null;
  const kind = GEOMETRY_KIND[geom.type];
  if (!kind) return null;
  if (!coordsLookValid(geom.type, geom.coordinates)) return null;
  return {
    kind,
    geometry: geom as Geometry,
    label: "",
    color: DEFAULT_COLORS[kind],
  };
}
