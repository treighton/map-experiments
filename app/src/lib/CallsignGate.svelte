<script lang="ts">
  let { onsubmit }: { onsubmit: (callsign: string) => void } = $props();
  let value = $state("");

  function submit() {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onsubmit(trimmed);
  }
</script>

<div class="gate">
  <div class="card">
    <h1>SAR Map</h1>
    <p>Enter your callsign to join.</p>
    <input
      placeholder="Callsign, e.g. Team3-Mike"
      bind:value
      onkeydown={(e) => e.key === "Enter" && submit()}
    />
    <button onclick={submit}>Join</button>
  </div>
</div>

<style>
  .gate {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #27323a;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    padding: 28px;
    width: min(90vw, 340px);
    text-align: center;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 12px;
    font-size: 16px;
    margin: 14px 0;
    border: 1px solid #ccc;
    border-radius: 8px;
  }
  button {
    width: 100%;
    padding: 12px;
    font-size: 16px;
    background: #1a7f37;
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
</style>
