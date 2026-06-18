import { describe, it, expect } from "vitest";
import { loadOrCreateIdentity } from "../src/identity.js";

/** In-memory stand-in for localStorage. */
class MemoryStore {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe("loadOrCreateIdentity", () => {
  it("generates a deviceId on first call and persists it", () => {
    const kv = new MemoryStore();
    const id = loadOrCreateIdentity(kv, "Team3-Mike", { newId: () => "dev-xyz" });
    expect(id).toEqual({ callsign: "Team3-Mike", deviceId: "dev-xyz" });
    expect(kv.getItem("sar.deviceId")).toBe("dev-xyz");
  });

  it("reuses an existing deviceId on later calls", () => {
    const kv = new MemoryStore();
    loadOrCreateIdentity(kv, "Team3-Mike", { newId: () => "dev-first" });
    const again = loadOrCreateIdentity(kv, "Team3-Mike-Renamed", { newId: () => "dev-second" });
    expect(again.deviceId).toBe("dev-first");
    expect(again.callsign).toBe("Team3-Mike-Renamed");
  });

  it("persists the latest callsign", () => {
    const kv = new MemoryStore();
    loadOrCreateIdentity(kv, "Old", { newId: () => "dev-1" });
    loadOrCreateIdentity(kv, "New", { newId: () => "dev-1" });
    expect(kv.getItem("sar.callsign")).toBe("New");
  });
});
