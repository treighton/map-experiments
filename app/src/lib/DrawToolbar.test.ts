import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// Fake terra-draw — reconciled to the REAL v1 API:
//   - finish callback receives (id: FeatureId, context: OnFinishContext)
//   - getSnapshotFeature(id) returns the feature for that id (or undefined)
//   - clear() removes all features
//   - setMode(name) switches the active mode
//
// vi.mock is hoisted to top-of-file. Everything used in mock factories must
// itself be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------

const { FakeTerraDraw, lastDrawRef } = vi.hoisted(() => {
  // Shared pointer so tests can reach the most recently created instance
  const lastDrawRef = { current: null as InstanceType<typeof FakeTerraDraw> | null };

  class FakeTerraDraw {
    started = false;
    mode = "static";
    private finishCbs: ((id: string, ctx: unknown) => void)[] = [];
    private featureMap = new Map<string, unknown>();
    constructor(_opts: unknown) {
      lastDrawRef.current = this as FakeTerraDraw;
    }
    start() {
      this.started = true;
    }
    setMode(m: string) {
      this.mode = m;
    }
    on(event: string, cb: (id: string, ctx: unknown) => void) {
      if (event === "finish") this.finishCbs.push(cb);
    }
    getSnapshot() {
      return Array.from(this.featureMap.values());
    }
    getSnapshotFeature(id: string) {
      return this.featureMap.get(id);
    }
    clear() {
      this.featureMap.clear();
    }
    stop() {}
    /** Test helper: store a feature by id, then fire the finish event */
    _emitFinish(id: string, feature: unknown) {
      this.featureMap.set(id, feature);
      for (const cb of this.finishCbs) cb(id, { mode: "point", action: "draw" });
    }
  }

  return { FakeTerraDraw, lastDrawRef };
});

vi.mock("terra-draw", () => ({
  TerraDraw: FakeTerraDraw,
  TerraDrawPointMode: class {
    mode = "point";
  },
  TerraDrawLineStringMode: class {
    mode = "linestring";
  },
  TerraDrawPolygonMode: class {
    mode = "polygon";
  },
}));

vi.mock("terra-draw-maplibre-gl-adapter", () => ({
  TerraDrawMapLibreGLAdapter: class {
    constructor(_o: unknown) {}
  },
}));

import DrawToolbar from "./DrawToolbar.svelte";

const ME = { callsign: "Mike", deviceId: "dev-me" };
function fakeMap() {
  return {} as never;
}

describe("DrawToolbar", () => {
  it("commits a finished marker to the store via create", () => {
    const create = vi.fn();
    const store = { create } as never;
    render(DrawToolbar, { map: fakeMap(), store, identity: ME });
    lastDrawRef.current!._emitFinish("feat-1", {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: {},
    });
    expect(create).toHaveBeenCalledWith(ME, {
      kind: "marker",
      geometry: { type: "Point", coordinates: [1, 2] },
      label: "",
      color: "#c1432f",
    });
  });

  it("does not create when the finished geometry is invalid", () => {
    const create = vi.fn();
    const store = { create } as never;
    render(DrawToolbar, { map: fakeMap(), store, identity: ME });
    lastDrawRef.current!._emitFinish("feat-bad", {
      type: "Feature",
      properties: {},
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("clears the draw scratch layer after committing", () => {
    const create = vi.fn();
    const store = { create } as never;
    render(DrawToolbar, { map: fakeMap(), store, identity: ME });
    const clearSpy = vi.spyOn(lastDrawRef.current!, "clear");
    lastDrawRef.current!._emitFinish("feat-2", {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: {},
    });
    expect(clearSpy).toHaveBeenCalled();
  });

  it("switches terra-draw mode when a tool button is clicked", async () => {
    const store = { create: vi.fn() } as never;
    const { getByRole } = render(DrawToolbar, {
      map: fakeMap(),
      store,
      identity: ME,
    });
    await fireEvent.click(getByRole("button", { name: /line/i }));
    expect(lastDrawRef.current!.mode).toBe("linestring");
  });
});
