<script lang="ts">
  let { callsign, online }: { callsign: string; online: boolean } = $props();
</script>

<div class="chip">
  <span class="name">{callsign}</span>
  <span class="dot" class:online aria-hidden="true">●</span>
  <span class="state">{online ? "live" : "offline"}</span>
</div>

<style>
  .chip {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(255, 255, 255, 0.92);
    border-radius: 14px;
    padding: 6px 12px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  }
  .dot {
    color: #b0392a;
  }
  .dot.online {
    color: #1a7f37;
  }
</style>
