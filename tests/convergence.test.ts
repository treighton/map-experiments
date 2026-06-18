import { describe, it, expect } from "vitest";
import { FeatureStore } from "../src/featureStore.js";
import type { Digest } from "../src/types.js";

const A = { callsign: "A", deviceId: "dev-a" };
const B = { callsign: "B", deviceId: "dev-b" };

/** Which ids the local side needs from the remote, given both digests. */
function idsNeeded(localDigest: Digest, remoteDigest: Digest): string[] {
  const need: string[] = [];
  for (const [id, remoteTs] of Object.entries(remoteDigest)) {
    const localTs = localDigest[id];
    if (localTs === undefined || remoteTs > localTs) need.push(id);
  }
  return need;
}

/** One full bidirectional reconcile between two stores. */
function reconcile(s1: FeatureStore, s2: FeatureStore): void {
  const d1 = s1.digest();
  const d2 = s2.digest();
  s1.applyDelta(s2.featuresFor(idsNeeded(d1, d2)));
  s2.applyDelta(s1.featuresFor(idsNeeded(d2, d1)));
}

function expectConverged(s1: FeatureStore, s2: FeatureStore): void {
  expect(s1.digest()).toEqual(s2.digest());
  expect(s1.toGeoJSON()).toEqual(s2.toGeoJSON());
}

describe("two-store convergence", () => {
  it("converges after exchanging disjoint features", () => {
    let t = 1;
    const s1 = new FeatureStore({ now: () => t, newId: () => "a1" });
    const s2 = new FeatureStore({ now: () => t, newId: () => "b1" });
    s1.create(A, { kind: "marker", geometry: { type: "Point", coordinates: [1, 1] }, label: "", color: "" });
    s2.create(B, { kind: "marker", geometry: { type: "Point", coordinates: [2, 2] }, label: "", color: "" });
    reconcile(s1, s2);
    expectConverged(s1, s2);
    expect(s1.list()).toHaveLength(2);
  });

  it("propagates a delete to the other store", () => {
    let t = 1;
    const s1 = new FeatureStore({ now: () => t, newId: () => "a1" });
    const s2 = new FeatureStore({ now: () => t, newId: () => "x" });
    s1.create(A, { kind: "marker", geometry: { type: "Point", coordinates: [1, 1] }, label: "", color: "" });
    reconcile(s1, s2);
    expect(s2.list()).toHaveLength(1);
    t = 2;
    s1.remove(A, "a1");
    reconcile(s1, s2);
    expectConverged(s1, s2);
    expect(s2.list()).toHaveLength(0);
  });

  it("converges regardless of reconcile direction order", () => {
    let t = 1;
    const s1 = new FeatureStore({ now: () => t, newId: () => "a1" });
    const s2 = new FeatureStore({ now: () => t, newId: () => "b1" });
    s1.create(A, { kind: "marker", geometry: { type: "Point", coordinates: [1, 1] }, label: "", color: "" });
    s2.create(B, { kind: "marker", geometry: { type: "Point", coordinates: [2, 2] }, label: "", color: "" });
    reconcile(s2, s1);
    expectConverged(s1, s2);
  });
});
