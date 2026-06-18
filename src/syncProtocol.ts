import type { Digest, SarFeature, FeatureKind } from "./types.js";

/**
 * Given the local and remote digests (id -> updatedAt), return the ids the local
 * side should request from the remote: ids the remote has that are unknown
 * locally or newer than the local copy. Pure.
 */
export function idsNeeded(local: Digest, remote: Digest): string[] {
  const need: string[] = [];
  for (const [id, remoteTs] of Object.entries(remote)) {
    const localTs = local[id];
    if (localTs === undefined || remoteTs > localTs) need.push(id);
  }
  return need;
}

const VALID_KINDS: ReadonlySet<FeatureKind> = new Set([
  "marker",
  "track",
  "line",
  "polygon",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Validate an untrusted value as a SarFeature. Returns the value typed as
 * SarFeature if every required property is well-formed, else null. Guards
 * especially against a non-finite updatedAt, which would poison digest()/LWW.
 * Pure; does not mutate the input.
 */
export function parseFeature(value: unknown): SarFeature | null {
  if (!isRecord(value)) return null;
  if (value.type !== "Feature") return null;
  if (!isRecord(value.geometry)) return null;
  const p = value.properties;
  if (!isRecord(p)) return null;
  if (typeof p.id !== "string" || p.id.length === 0) return null;
  if (typeof p.updatedAt !== "number" || !Number.isFinite(p.updatedAt)) {
    return null;
  }
  if (typeof p.createdAt !== "number" || !Number.isFinite(p.createdAt)) {
    return null;
  }
  if (typeof p.authorDeviceId !== "string" || p.authorDeviceId.length === 0) {
    return null;
  }
  if (typeof p.author !== "string") return null;
  if (typeof p.deleted !== "boolean") return null;
  if (typeof p.kind !== "string" || !VALID_KINDS.has(p.kind as FeatureKind)) {
    return null;
  }
  return value as unknown as SarFeature;
}
