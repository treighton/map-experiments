import { describe, it, expect } from "vitest";
import { toCreateInput } from "./createFeature.js";

describe("toCreateInput", () => {
  it("maps a Point to a marker", () => {
    const input = toCreateInput({
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: {},
    });
    expect(input).toEqual({
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "#c1432f",
    });
  });

  it("maps a LineString to a line", () => {
    const input = toCreateInput({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      properties: {},
    });
    expect(input?.kind).toBe("line");
  });

  it("maps a Polygon to a polygon", () => {
    const input = toCreateInput({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      properties: {},
    });
    expect(input?.kind).toBe("polygon");
  });

  it("returns null for a missing geometry", () => {
    expect(toCreateInput({ type: "Feature", properties: {} } as never)).toBeNull();
  });

  it("returns null for an unsupported geometry type", () => {
    expect(
      toCreateInput({
        type: "Feature",
        geometry: { type: "MultiPolygon", coordinates: [] },
        properties: {},
      } as never),
    ).toBeNull();
  });

  it("returns null for a Point with non-array coordinates", () => {
    expect(
      toCreateInput({
        type: "Feature",
        geometry: { type: "Point", coordinates: "nope" },
        properties: {},
      } as never),
    ).toBeNull();
  });
});
