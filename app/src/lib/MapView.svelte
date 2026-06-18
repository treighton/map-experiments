<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import maplibregl from "maplibre-gl";
  import "maplibre-gl/dist/maplibre-gl.css";
  import type { MapStore } from "../mapStore.js";

  let {
    mapStore,
    onready,
  }: { mapStore: MapStore; onready: (map: maplibregl.Map) => void } = $props();

  let container: HTMLDivElement;
  let map: maplibregl.Map | undefined;
  let unsub: (() => void) | undefined;

  const SOURCE_ID = "features";

  const STYLE = {
    version: 8 as const,
    sources: {
      osm: {
        type: "raster" as const,
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster" as const, source: "osm" }],
  };

  onMount(() => {
    map = new maplibregl.Map({
      container,
      style: STYLE,
      center: [0, 0],
      zoom: 2,
    });

    map.on("load", () => {
      const m = map!;
      m.addSource(SOURCE_ID, { type: "geojson", data: mapStore.toGeoJSON() });
      m.addLayer({
        id: "features-fill",
        type: "fill",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "polygon"],
        paint: { "fill-color": ["get", "color"], "fill-opacity": 0.2 },
      });
      m.addLayer({
        id: "features-line",
        type: "line",
        source: SOURCE_ID,
        filter: ["in", ["get", "kind"], ["literal", ["line", "polygon", "track"]]],
        paint: { "line-color": ["get", "color"], "line-width": 3 },
      });
      m.addLayer({
        id: "features-point",
        type: "circle",
        source: SOURCE_ID,
        filter: ["==", ["get", "kind"], "marker"],
        paint: {
          "circle-radius": 7,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fff",
        },
      });

      unsub = mapStore.features.subscribe(() => {
        const src = m.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
        src?.setData(mapStore.toGeoJSON());
      });

      onready(m);
    });
  });

  onDestroy(() => {
    // Unsubscribe our own features subscription and tear down the map. We do NOT
    // call mapStore.destroy() — the app owns the mapStore lifetime (see mapStore.ts).
    unsub?.();
    map?.remove();
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map {
    position: absolute;
    inset: 0;
  }
</style>
