<script lang="ts">
  import { onMount } from "svelte";
  import MapView from "./MapView.svelte";
  import DrawToolbar from "./DrawToolbar.svelte";
  import StatusChip from "./StatusChip.svelte";
  import type { AppContext } from "../app.js";
  import type { Identity } from "@sartools/feature-store";
  import type maplibregl from "maplibre-gl";

  let { ctx, identity }: { ctx: AppContext; identity: Identity } = $props();

  let map = $state<maplibregl.Map | null>(null);

  // Heuristic for v1: navigator.onLine reflects the network interface, not the
  // actual WebSocket/relay state. Good enough for the status chip; a precise
  // per-connection status is a later refinement.
  let online = $state(typeof navigator !== "undefined" ? navigator.onLine : true);

  onMount(() => {
    const onOnline = () => (online = true);
    const onOffline = () => (online = false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  });
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
