<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    TerraDraw,
    TerraDrawPointMode,
    TerraDrawLineStringMode,
    TerraDrawPolygonMode,
  } from "terra-draw";
  import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
  import type { FeatureStore, Identity } from "@sartools/feature-store";
  import { toCreateInput } from "./createFeature.js";

  let {
    map,
    store,
    identity,
  }: { map: unknown; store: FeatureStore; identity: Identity } = $props();

  let draw: TerraDraw;
  let active = $state<"marker" | "line" | "polygon" | null>(null);
  let finishHandler: ((id: string | number) => void) | undefined;

  // Real terra-draw v1 mode name strings match the mode class `.mode` property
  const MODE_FOR: Record<"marker" | "line" | "polygon", string> = {
    marker: "point",
    line: "linestring",
    polygon: "polygon",
  };

  onMount(() => {
    draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map } as never),
      modes: [
        new TerraDrawPointMode(),
        new TerraDrawLineStringMode(),
        new TerraDrawPolygonMode(),
      ],
    });
    draw.start();

    // Real v1 API: finish callback receives (id: FeatureId, context: OnFinishContext)
    // Use getSnapshotFeature(id) to retrieve the completed feature.
    finishHandler = (id) => {
      const feature = draw.getSnapshotFeature(id);
      if (!feature) {
        draw.clear();
        active = null;
        return;
      }
      const input = toCreateInput(feature as { type: "Feature"; geometry?: { type?: string; coordinates?: unknown }; properties?: unknown });
      if (input) store.create(identity, input);
      draw.clear();
      active = null;
    };
    draw.on("finish", finishHandler);
  });

  onDestroy(() => {
    if (finishHandler) draw?.off?.("finish", finishHandler);
    draw?.stop?.();
  });

  function pick(tool: "marker" | "line" | "polygon") {
    active = tool;
    draw.setMode(MODE_FOR[tool]);
  }
</script>

<div class="toolbar">
  <button
    class:active={active === "marker"}
    onclick={() => pick("marker")}
    aria-label="Marker"
  >
    📍
  </button>
  <button
    class:active={active === "line"}
    onclick={() => pick("line")}
    aria-label="Line"
  >
    ／
  </button>
  <button
    class:active={active === "polygon"}
    onclick={() => pick("polygon")}
    aria-label="Polygon"
  >
    ⬠
  </button>
</div>

<style>
  .toolbar {
    position: absolute;
    top: 12px;
    left: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  button {
    width: 44px;
    height: 44px;
    border-radius: 8px;
    border: none;
    background: #fff;
    font-size: 18px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
    cursor: pointer;
  }
  button.active {
    background: #1a7f37;
  }
</style>
