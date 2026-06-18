# SAR Map UI

A Svelte PWA that renders the FeatureStore on a MapLibre map, draws
markers/lines/polygons with terra-draw, and syncs live via a SyncClient.

## Run

Start the dev sync server (the field/cloud relay), then the app:

```bash
cd app
npm install
npm run sync-server   # ws://localhost:8787  (in one terminal)
npm run dev           # Vite dev server (in another terminal), prints a URL
```

Open the printed URL (default: http://localhost:5173). Override the sync server
with `VITE_SYNC_URL` if needed (defaults to `ws://localhost:8787`).

## Manual end-to-end verification

1. Open the app → enter a callsign (e.g. Team3-Mike) → Join.
2. The map appears. Pick the marker tool, tap the map → a marker appears.
3. Pick the line tool, draw a line; pick the polygon tool, draw a polygon.
4. Reload the page → your features are still there (IndexedDB persistence).
5. Open the app in a SECOND browser/tab, enter a different callsign.
6. Draw a feature in one → it appears in the other within a moment (live sync).
7. The StatusChip shows your callsign and live/offline state.

## Tests

```bash
cd app && npm test          # unit + component tests (Vitest + jsdom)
cd app && npm run build     # production build
cd app && npm run typecheck # svelte-check
```
