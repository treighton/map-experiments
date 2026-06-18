import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/svelte";
import { FeatureStore } from "@sartools/feature-store";
import { createMapStore } from "../mapStore.js";

const setData = vi.fn();
const addSource = vi.fn();
const addLayer = vi.fn();
const getSource = vi.fn((id: string) => (id === "features" ? { setData } : undefined));
const on = vi.fn((event: string, cb: () => void) => {
  if (event === "load") cb();
});
const remove = vi.fn();

vi.mock("maplibre-gl", () => {
  class FakeMap {
    on = on;
    addSource = addSource;
    addLayer = addLayer;
    getSource = getSource;
    remove = remove;
    constructor(_opts: unknown) {}
  }
  return { default: { Map: FakeMap }, Map: FakeMap };
});

const ME = { callsign: "Mike", deviceId: "dev-me" };

beforeEach(() => {
  setData.mockClear();
  addSource.mockClear();
  addLayer.mockClear();
  getSource.mockClear();
  on.mockClear();
});

import MapView from "./MapView.svelte";

describe("MapView", () => {
  it("adds a features source and calls setData on a store change", async () => {
    const store = new FeatureStore({ now: () => 1, newId: () => "id-1" });
    const mapStore = createMapStore(store);
    render(MapView, { mapStore, onready: () => {} });

    expect(addSource).toHaveBeenCalledWith(
      "features",
      expect.objectContaining({ type: "geojson" }),
    );

    store.create(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "",
    });
    expect(setData).toHaveBeenCalled();
  });

  it("calls onready with the map instance after load", async () => {
    const store = new FeatureStore({ now: () => 1, newId: () => "id-1" });
    const mapStore = createMapStore(store);
    const onready = vi.fn();
    render(MapView, { mapStore, onready });
    expect(onready).toHaveBeenCalledWith(expect.anything());
  });
});
