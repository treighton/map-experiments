import { describe, it, expect } from "vitest";
import { idsNeeded } from "../src/syncProtocol.js";
import { parseFeature } from "../src/syncProtocol.js";

describe("idsNeeded", () => {
  it("requests ids the remote has that the local lacks", () => {
    expect(idsNeeded({}, { a: 1, b: 2 }).sort()).toEqual(["a", "b"]);
  });

  it("requests ids the remote has newer", () => {
    expect(idsNeeded({ a: 1 }, { a: 2 })).toEqual(["a"]);
  });

  it("does not request ids the local has newer or equal", () => {
    expect(idsNeeded({ a: 2 }, { a: 2 })).toEqual([]);
    expect(idsNeeded({ a: 3 }, { a: 2 })).toEqual([]);
  });

  it("ignores local-only ids", () => {
    expect(idsNeeded({ a: 1, b: 1 }, { a: 1 })).toEqual([]);
  });
});

function validFeatureObject() {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [1, 2] },
    properties: {
      id: "f1",
      author: "A",
      authorDeviceId: "dev-a",
      createdAt: 100,
      updatedAt: 200,
      deleted: false,
      kind: "marker",
      label: "x",
      color: "red",
    },
  };
}

describe("parseFeature", () => {
  it("accepts a well-formed feature and returns it", () => {
    const f = validFeatureObject();
    expect(parseFeature(f)).toEqual(f);
  });

  it("rejects non-objects", () => {
    expect(parseFeature(null)).toBeNull();
    expect(parseFeature("nope")).toBeNull();
    expect(parseFeature(42)).toBeNull();
  });

  it("rejects a missing or empty id", () => {
    const f = validFeatureObject();
    delete (f.properties as Record<string, unknown>).id;
    expect(parseFeature(f)).toBeNull();
    const f2 = validFeatureObject();
    f2.properties.id = "";
    expect(parseFeature(f2)).toBeNull();
  });

  it("rejects a non-finite updatedAt (NaN/missing) that would poison LWW", () => {
    const f = validFeatureObject();
    (f.properties as Record<string, unknown>).updatedAt = Number.NaN;
    expect(parseFeature(f)).toBeNull();
    const f2 = validFeatureObject();
    delete (f2.properties as Record<string, unknown>).updatedAt;
    expect(parseFeature(f2)).toBeNull();
  });

  it("rejects a missing authorDeviceId or kind", () => {
    const f = validFeatureObject();
    delete (f.properties as Record<string, unknown>).authorDeviceId;
    expect(parseFeature(f)).toBeNull();
    const f2 = validFeatureObject();
    delete (f2.properties as Record<string, unknown>).kind;
    expect(parseFeature(f2)).toBeNull();
  });

  it("rejects a non-boolean deleted", () => {
    const f = validFeatureObject();
    (f.properties as Record<string, unknown>).deleted = "yes";
    expect(parseFeature(f)).toBeNull();
  });

  it("rejects an unknown kind", () => {
    const f = validFeatureObject();
    f.properties.kind = "spaceship";
    expect(parseFeature(f)).toBeNull();
  });

  it("rejects a missing geometry", () => {
    const f = validFeatureObject();
    delete (f as Record<string, unknown>).geometry;
    expect(parseFeature(f)).toBeNull();
  });
});
