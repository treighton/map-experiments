import type { SarFeature } from "./types.js";

/**
 * Resolve two versions of the same feature by last-write-wins.
 * Newer updatedAt wins; ties broken by higher authorDeviceId for determinism.
 * If both updatedAt and authorDeviceId are equal (e.g. the same device writing
 * twice within one millisecond), a stable serialization of the two features is
 * compared so the choice is deterministic and identical across stores.
 * Pure: returns one of the inputs unchanged.
 */
export function mergeFeature(a: SarFeature, b: SarFeature): SarFeature {
  const pa = a.properties;
  const pb = b.properties;
  if (pa.updatedAt !== pb.updatedAt) {
    return pa.updatedAt > pb.updatedAt ? a : b;
  }
  if (pa.authorDeviceId !== pb.authorDeviceId) {
    return pa.authorDeviceId > pb.authorDeviceId ? a : b;
  }
  // Final total-order tiebreaker: same updatedAt AND same authorDeviceId
  // (e.g. one device writing twice within a millisecond). Compare a stable
  // serialization so any two stores deterministically choose the same winner,
  // making the merge genuinely commutative rather than argument-order dependent.
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
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
