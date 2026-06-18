import { describe, it, expect } from "vitest";
import { mergeFeature } from "../src/merge.js";
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
