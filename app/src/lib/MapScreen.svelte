<script lang="ts">
  import MapView from "./MapView.svelte";
  import DrawToolbar from "./DrawToolbar.svelte";
  import StatusChip from "./StatusChip.svelte";
  import type { AppContext } from "../app.js";
  import type { Identity } from "@sartools/feature-store";
  import type maplibregl from "maplibre-gl";

  let { ctx, identity }: { ctx: AppContext; identity: Identity } = $props();

  let map = $state<maplibregl.Map | null>(null);
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => (online = true));
    window.addEventListener("offline", () => (online = false));
  }
</script>

<div class="screen">
  <MapView mapStore={ctx.mapStore} onready={(m) => (map = m)} />
  {#if map}
    <DrawToolbar {map} store={ctx.store} {identity} />
  {/if}
  <StatusChip callsign={identity.callsign} {online} />
</div>

<style>
  .screen {
    position: fixed;
    inset: 0;
  }
</style>
