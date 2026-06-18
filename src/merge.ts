import type { SarFeature } from "./types.js";

/**
 * Resolve two versions of the same feature by last-write-wins.
 * Newer updatedAt wins; ties broken by higher authorDeviceId for determinism.
 * If both updatedAt and authorDeviceId are equal (e.g. the same device writing
 * twice within one millisecond), the result is left-biased: `a` is returned.
 * That collision is expected to be prevented at the application layer.
 * Pure: returns one of the inputs unchanged.
 */
export function mergeFeature(a: SarFeature, b: SarFeature): SarFeature {
  const pa = a.properties;
  const pb = b.properties;
  if (pa.updatedAt !== pb.updatedAt) {
    return pa.updatedAt > pb.updatedAt ? a : b;
  }
  return pa.authorDeviceId >= pb.authorDeviceId ? a : b;
}

/**
 * Merge incoming features into a copy of the local map (id -> feature).
 * Pure: returns a new Map, never mutates the input.
 */
export function mergeAll(
  local: ReadonlyMap<string, SarFeature>,
  incoming: readonly SarFeature[],
): Map<string, SarFeature> {
  const out = new Map(local);
  for (const f of incoming) {
    const existing = out.get(f.properties.id);
    out.set(f.properties.id, existing ? mergeFeature(existing, f) : f);
  }
  return out;
}
