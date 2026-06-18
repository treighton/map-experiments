import type { Digest, SarFeature, FeatureKind } from "./types.js";

export type SyncMessage =
  | { type: "digest"; entries: Digest }
  | { type: "need"; ids: string[] }
  | { type: "features"; features: SarFeature[] }
  | { type: "upsert"; features: SarFeature[] };

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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNumberRecord(v: unknown): v is Digest {
  if (!isRecord(v)) return false;
  return Object.values(v).every(
    (n) => typeof n === "number" && Number.isFinite(n),
  );
}

/** Collect the valid features from an unknown array; drop invalid ones. */
function parseFeatureArray(value: unknown): SarFeature[] | null {
  if (!Array.isArray(value)) return null;
  const out: SarFeature[] = [];
  for (const item of value) {
    const f = parseFeature(item);
    if (f) out.push(f);
  }
  return out;
}

/**
 * Parse and validate an untrusted wire string into a SyncMessage, or null if it
 * is malformed. For features/upsert, invalid individual features are dropped
 * (logged by the caller); the message itself stays valid. Pure.
 */
export function parseMessage(raw: string): SyncMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  switch (parsed.type) {
    case "digest":
      return isNumberRecord(parsed.entries)
        ? { type: "digest", entries: parsed.entries }
        : null;
    case "need":
      return isStringArray(parsed.ids)
        ? { type: "need", ids: parsed.ids }
        : null;
    case "features": {
      const features = parseFeatureArray(parsed.features);
      return features ? { type: "features", features } : null;
    }
    case "upsert": {
      const features = parseFeatureArray(parsed.features);
      return features ? { type: "upsert", features } : null;
    }
    default:
      return null;
  }
}
