import { describe, it, expect } from "vitest";
import { FeatureStore } from "../src/featureStore.js";

const ME = { callsign: "Team3-Mike", deviceId: "dev-me" };

function makeStore() {
  return new FeatureStore({ now: () => 1000, newId: () => "id-1" });
}

describe("FeatureStore create/query", () => {
  it("creates a feature stamped with author and timestamps", () => {
    const store = makeStore();
    const f = store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "tent",
      color: "red",
    });
    expect(f.properties.id).toBe("id-1");
    expect(f.properties.author).toBe("Team3-Mike");
    expect(f.properties.authorDeviceId).toBe("dev-me");
    expect(f.properties.createdAt).toBe(1000);
    expect(f.properties.updatedAt).toBe(1000);
    expect(f.properties.deleted).toBe(false);
  });

  it("lists only non-deleted features", () => {
    const store = makeStore();
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(store.list()).toHaveLength(1);
  });

  it("exports a GeoJSON FeatureCollection of non-deleted features", () => {
    const store = makeStore();
    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    const fc = store.toGeoJSON();
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(1);
  });
});
