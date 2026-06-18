import { describe, it, expect } from "vitest";
import { idsNeeded } from "../src/syncProtocol.js";
import { parseFeature } from "../src/syncProtocol.js";
import { parseMessage } from "../src/syncProtocol.js";

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

describe("parseMessage", () => {
  it("parses a digest message", () => {
    const raw = JSON.stringify({ type: "digest", entries: { a: 1 } });
    expect(parseMessage(raw)).toEqual({ type: "digest", entries: { a: 1 } });
  });

  it("parses a need message", () => {
    const raw = JSON.stringify({ type: "need", ids: ["a", "b"] });
    expect(parseMessage(raw)).toEqual({ type: "need", ids: ["a", "b"] });
  });

  it("parses a features message, validating each feature", () => {
    const feature = validFeatureObject();
    const raw = JSON.stringify({ type: "features", features: [feature] });
    expect(parseMessage(raw)).toEqual({ type: "features", features: [feature] });
  });

  it("drops invalid features from a features message but keeps valid ones", () => {
    const good = validFeatureObject();
    const bad = { type: "Feature", properties: { id: "" } };
    const raw = JSON.stringify({ type: "features", features: [good, bad] });
    expect(parseMessage(raw)).toEqual({ type: "features", features: [good] });
  });

  it("parses an upsert message", () => {
    const feature = validFeatureObject();
    const raw = JSON.stringify({ type: "upsert", features: [feature] });
    expect(parseMessage(raw)).toEqual({ type: "upsert", features: [feature] });
  });

  it("returns null on malformed JSON", () => {
    expect(parseMessage("{not json")).toBeNull();
  });

  it("returns null on an unknown message type", () => {
    expect(parseMessage(JSON.stringify({ type: "bogus" }))).toBeNull();
  });

  it("returns null when digest entries is not an object", () => {
    expect(parseMessage(JSON.stringify({ type: "digest", entries: 5 }))).toBeNull();
  });

  it("returns null when need ids is not an array of strings", () => {
    expect(parseMessage(JSON.stringify({ type: "need", ids: "a" }))).toBeNull();
  });
});
