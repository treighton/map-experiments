import { newId as defaultNewId } from "./uuid.js";
import type { Identity } from "./types.js";

/** Minimal key-value interface satisfied by Web Storage (localStorage). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEVICE_KEY = "sar.deviceId";
const CALLSIGN_KEY = "sar.callsign";

/**
 * Load the stable device identity, generating and persisting a deviceId on first
 * use. The callsign is always updated to the value supplied by the caller.
 */
export function loadOrCreateIdentity(
  kv: KeyValueStore,
  callsign: string,
  deps: { newId?: () => string } = {},
): Identity {
  const newId = deps.newId ?? defaultNewId;
  let deviceId = kv.getItem(DEVICE_KEY);
  if (deviceId === null) {
    deviceId = newId();
    kv.setItem(DEVICE_KEY, deviceId);
  }
  kv.setItem(CALLSIGN_KEY, callsign);
  return { callsign, deviceId };
}
