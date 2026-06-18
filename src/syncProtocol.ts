import type { Digest } from "./types.js";

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
