import { describe, it, expect } from "vitest";
import { mergeFeature, mergeAll } from "../src/merge.js";
import type { SarFeature } from "../src/types.js";

function feat(over: Partial<SarFeature["properties"]> = {}): SarFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      id: "f1",
      author: "A",
      authorDeviceId: "dev-a",
      createdAt: 100,
      updatedAt: 100,
      deleted: false,
      kind: "marker",
      label: "",
      color: "",
      ...over,
    },
  };
}

describe("mergeFeature", () => {
  it("keeps the feature with the newer updatedAt", () => {
    const older = feat({ updatedAt: 100, label: "old" });
    const newer = feat({ updatedAt: 200, label: "new" });
    expect(mergeFeature(older, newer).properties.label).toBe("new");
    expect(mergeFeature(newer, older).properties.label).toBe("new");
  });

  it("breaks ties by authorDeviceId (higher wins)", () => {
    const a = feat({ updatedAt: 100, authorDeviceId: "dev-a", label: "a" });
    const b = feat({ updatedAt: 100, authorDeviceId: "dev-b", label: "b" });
    expect(mergeFeature(a, b).properties.label).toBe("b");
    expect(mergeFeature(b, a).properties.label).toBe("b");
  });

  it("is idempotent", () => {
    const a = feat({ updatedAt: 100 });
    expect(mergeFeature(a, a)).toEqual(a);
  });

  it("a later delete wins over an earlier edit", () => {
    const edit = feat({ updatedAt: 100, deleted: false });
    const del = feat({ updatedAt: 200, deleted: true });
    expect(mergeFeature(edit, del).properties.deleted).toBe(true);
  });

  it("a later edit resurrects over an earlier delete", () => {
    const del = feat({ updatedAt: 100, deleted: true });
    const edit = feat({ updatedAt: 200, deleted: false });
    expect(mergeFeature(del, edit).properties.deleted).toBe(false);
  });
});

describe("mergeAll", () => {
  it("unions disjoint feature sets", () => {
    const local = new Map([["f1", feat({ id: "f1" })]]);
    const incoming = [feat({ id: "f2" })];
    const out = mergeAll(local, incoming);
    expect([...out.keys()].sort()).toEqual(["f1", "f2"]);
  });

  it("resolves overlapping ids by LWW", () => {
    const local = new Map([["f1", feat({ id: "f1", updatedAt: 100, label: "old" })]]);
    const incoming = [feat({ id: "f1", updatedAt: 200, label: "new" })];
    const out = mergeAll(local, incoming);
    expect(out.get("f1")!.properties.label).toBe("new");
  });

  it("is commutative on final state regardless of input order", () => {
    const x = feat({ id: "f1", updatedAt: 100 });
    const y = feat({ id: "f1", updatedAt: 200 });
    const ab = mergeAll(new Map([["f1", x]]), [y]);
    const ba = mergeAll(new Map([["f1", y]]), [x]);
    expect(ab.get("f1")).toEqual(ba.get("f1"));
  });

  it("does not mutate the input map", () => {
    const local = new Map([["f1", feat({ id: "f1", updatedAt: 100 })]]);
    mergeAll(local, [feat({ id: "f1", updatedAt: 200 })]);
    expect(local.get("f1")!.properties.updatedAt).toBe(100);
  });
});
