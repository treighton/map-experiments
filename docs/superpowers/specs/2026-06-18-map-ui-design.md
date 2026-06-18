# Map UI — Render, Draw & Live Sync (Svelte PWA) — Design

**Date:** 2026-06-18
**Status:** Approved design, ready for implementation planning
**Builds on:** the complete backend — `@sartools/feature-store` (FeatureStore,
IndexedDbPersistence, SyncClient, BrowserWebSocketConnection, Identity) across the
CRDT core, persistence, sync protocol, relay, and WebSocket transport plans.

## Overview

The first UI layer: a Svelte PWA that renders the FeatureStore on a MapLibre map,
lets the user draw markers/lines/polygons with terra-draw, and wires it all to a
live SyncClient. The result is the core interactive loop — draw on two devices and
watch features sync live. The backend package is consumed untouched; no UI
dependency leaks into it.

## Goals

- Render the FeatureStore's features on a MapLibre map, updating live as features
  change (locally drawn, loaded from persistence, or received from a peer).
- Draw markers, lines, and polygons with terra-draw; committed shapes become
  FeatureStore features stamped with the user's callsign.
- Wire a live SyncClient (browser WebSocket) so two devices converge in real time.
- Persist via IndexedDbPersistence so features survive reload.
- Blocking callsign entry on first load so every feature carries a real author.
- Keep the backend framework-agnostic — Svelte reactivity is bridged via a thin
  adapter, not baked into the store.

## Non-Goals (v1 scope cuts — YAGNI)

- Feature editing / deletion UI (create-only via the draw tools).
- Feature-list side panel.
- Offline PMTiles / service worker / PWA install (the TileManager plan; v1 uses an
  online tile source).
- Feature styling UI (sensible default colors per kind).
- GPS / device location.
- Auth.

## Framework & Layout Decisions

- **Svelte** (compiles to a tiny runtime — good for field devices; clean for
  wrapping MapLibre's imperative API), built with **Vite**.
- **Layout A — floating toolbar:** full-bleed map; a floating draw-tool palette in
  one corner; a callsign + sync-status chip in another; a blocking callsign gate
  overlay until identity is set. Maximizes map area for field use.

## Architecture

```
   ┌──────────────────────── Svelte PWA (Vite) ────────────────────────┐
   │  App.svelte                                                        │
   │   ├─ CallsignGate (blocking until identity set)                    │
   │   └─ MapScreen                                                     │
   │        ├─ MapView ─── MapLibre (imperative, onMount) ── GeoJSON src│
   │        ├─ DrawToolbar (floating) ─── terra-draw (active tool)      │
   │        └─ StatusChip (callsign · sync state)                       │
   │  mapStore.ts  ── Svelte store adapter ── subscribes onChange,      │
   │                  exposes $features + toGeoJSON() snapshot          │
   └────────────────────────────────────────────────────────────────────┘
                              │ consumes (untouched)
   ┌──── @sartools/feature-store (backend) ────────────────────────────┐
   │  FeatureStore · IndexedDbPersistence · SyncClient · Identity       │
   └────────────────────────────────────────────────────────────────────┘
```

A new Vite + Svelte app consumes the existing backend package. The bridge is
`mapStore.ts`: a Svelte-store adapter subscribing to `featureStore.onChange` and
exposing reactive `$features`. The feature rendering (MapLibre GeoJSON source) and
any UI read from this one reactive source. Setup (`app.ts`) constructs the backend
objects and provides them via Svelte context — no globals.

## Components & Boundaries

| Component / module | Responsibility | Depends on |
|---|---|---|
| `app.ts` (setup) | Construct FeatureStore + IndexedDbPersistence (load then attach) + SyncClient + Identity; create mapStore; put on Svelte context | `@sartools/feature-store` |
| `mapStore.ts` | Svelte-store adapter: subscribe `onChange` → reactive `$features`; expose `toGeoJSON()` snapshot | FeatureStore |
| `App.svelte` | Root: CallsignGate until identity set, else MapScreen | context |
| `CallsignGate.svelte` | Blocking callsign input on first load; `loadOrCreateIdentity`; emits identity | Identity |
| `MapScreen.svelte` | Compose MapView + DrawToolbar + StatusChip (Layout A) | — |
| `MapView.svelte` | Owns MapLibre lifecycle; one GeoJSON source + styled layers per `kind`; `setData(toGeoJSON())` on store change | MapLibre, mapStore |
| `DrawToolbar.svelte` | Floating palette (marker/line/polygon); sets active terra-draw mode; on `finish` → `featureStore.create()` | terra-draw, FeatureStore, Identity |
| `StatusChip.svelte` | Callsign + live/offline sync state | SyncClient, Identity |

**Boundaries:** `MapView` is the only component touching MapLibre internals;
`DrawToolbar` the only one touching terra-draw; `CallsignGate` the only one
touching identity entry; `mapStore` the single reactive bridge. `MapView` creates
the MapLibre map and exposes the instance (via context/prop) once ready;
`DrawToolbar` borrows that reference to attach terra-draw.

## Data Flow

**Drawing a feature (local):**
```
user draws → terra-draw "finish" (geometry)
  → DrawToolbar: featureStore.create(identity, { kind, geometry, label:"", color })
  → FeatureStore: store + notify(ids, "local")
       ├→ mapStore: re-emit $features → MapView.setData(toGeoJSON()) → render
       ├→ IndexedDbPersistence: persist (debounced)
       └→ SyncClient session: broadcast upsert to peers
  → DrawToolbar clears terra-draw's scratch layer (feature now renders via source)
```

**Receiving a feature (from a peer):**
```
SyncClient receives upsert → featureStore.applyDelta → notify(ids, "remote")
  ├→ mapStore: re-emit $features → MapView.setData(toGeoJSON()) → render
  └→ IndexedDbPersistence: persist
  (remote-origin: terminal, not rebroadcast — the echo suppression already built)
```

**Key property:** locally-drawn and peer-sync'd features travel the identical
render path (`notify → mapStore → setData`). terra-draw only handles the in-progress
gesture; once committed, the feature is owned by the store and rendered by the
GeoJSON source, exactly like a sync'd feature.

**Boot flow:**
```
app.ts: new FeatureStore → persistence.load(store) → persistence.attach(store)
  → new SyncClient(store, browserWsConnectionFactory) → client.start()
  → mapStore = createMapStore(store)
App.svelte: identity set? MapScreen (renders loaded + sync'd features) : CallsignGate
```

## Build Setup

- **Vite + Svelte + TypeScript** app in a subdirectory (`app/`), so the backend
  package and UI stay cleanly separated. The app imports the backend via a
  workspace/relative dependency.
- **Dependencies:** `svelte`, `vite`, `@sveltejs/vite-plugin-svelte`,
  `maplibre-gl`, `terra-draw` (+ its MapLibre adapter), plus local
  `@sartools/feature-store`.
- **Tiles:** v1 uses an online raster/vector tile URL (offline PMTiles + service
  worker are the TileManager plan). Sync + draw + persistence already work offline;
  only the tile basemap needs connectivity in v1.

## Error Handling

- **Tiles fail to load** — MapLibre shows a blank grid; draw/sync/persist still
  work. A "tiles offline" hint in the StatusChip.
- **terra-draw `finish` with invalid geometry** — guard before `create()`; skip +
  log rather than storing a malformed feature.
- **SyncClient offline** — StatusChip shows "offline"; drawing continues; the
  proven reconnect handles recovery.
- **Persistence load failure** — fall back to in-memory (the adapter rejects
  cleanly); warn in the StatusChip.
- **No callsign yet** — CallsignGate blocks the map, so no feature is created
  without an author.

## Testing Strategy

- **`mapStore` adapter (unit, Vitest):** subscribing republishes on `onChange`;
  `$features` reflects create/remove; unsubscribe on teardown. Pure, no DOM.
- **Components (Vitest + @testing-library/svelte, jsdom):** CallsignGate emits
  identity and persists; DrawToolbar's `finish` handler calls `featureStore.create`
  with the right kind/geometry (terra-draw mocked); StatusChip reflects sync state.
- **MapView:** a lightweight test that the GeoJSON source receives `setData` on a
  store change (MapLibre mocked to a spy); the GL canvas itself is verified
  manually.
- **Manual milestone:** run the app, enter a callsign, draw marker/line/polygon,
  see them render; open a second browser/device, draw, watch it sync live — the
  human-visible proof the whole stack works end to end.
