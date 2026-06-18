<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import CallsignGate from "./CallsignGate.svelte";
  import MapScreen from "./MapScreen.svelte";
  import { createAppContext, type AppContext } from "../app.js";
  import type { Identity } from "@sartools/feature-store";

  let ctx = $state<AppContext | null>(null);
  let identity = $state<Identity | null>(null);

  onMount(async () => {
    ctx = await createAppContext();
    identity = ctx.getIdentity();
  });

  onDestroy(() => {
    ctx?.destroy();
  });

  function onCallsign(callsign: string) {
    if (!ctx) return;
    identity = ctx.setCallsign(callsign);
  }
</script>

{#if ctx && identity}
  <MapScreen {ctx} {identity} />
{:else if ctx}
  <CallsignGate onsubmit={onCallsign} />
{/if}
