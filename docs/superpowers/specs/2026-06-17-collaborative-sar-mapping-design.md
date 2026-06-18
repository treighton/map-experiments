# Collaborative Offline-First SAR Mapping Tool — Design

**Date:** 2026-06-17
**Status:** Approved design, ready for implementation planning

## Overview

A collaborative mapping tool for Search and Rescue (SAR) operations. Teams add
markers, GPS tracks, lines, and polygons to a shared map. The tool is
offline-first: clients work fully without connectivity, sync over local WiFi
through a field server, and reach a cloud server opportunistically when internet
is available. All map data persists as GeoJSON.

## Goals

- Real-time collaborative editing among field teams.
- Fully functional offline — a client never blocks on a server.
- Three-tier sync (client → field server → cloud) where every tier is a peer.
- Downloadable, guaranteed offline map tile coverage of an operation area.
- Map data persisted and exportable as standard GeoJSON.
- Join-and-go: no login wall during an active operation.

## Non-Goals (v1 scope cuts — YAGNI)

- User accounts / authentication.
- Server-side ownership enforcement (ownership is a client-side guard only).
- PMTiles generation (the app consumes a pre-built `.pmtiles` file).
- Fine-grained vertex-level merge of a single feature.
- Background GPS tracking (foreground GPS marker only).
- Native mobile/desktop apps (PWA only for v1; native wrapper is a future option).

## Architecture — Three-Tier Sync

```
┌─────────────┐   local WiFi    ┌──────────────┐   internet      ┌──────────────┐
│   Client    │ ◄────sync────►  │ Field Server │ ◄────sync────►  │ Cloud Server │
│   (PWA)     │                 │ (laptop/Pi)  │                 │  (canonical) │
│             │                 │              │                 │              │
│ • MapLibre  │                 │ • sync relay │                 │ • sync relay │
│ • terra-draw│                 │ • PMTiles    │                 │ • PMTiles    │
│ • IndexedDB │                 │   host       │                 │   host       │
│ • SW cache  │                 │ • feature    │                 │ • feature    │
│             │                 │   store      │                 │   store      │
└─────────────┘                 └──────────────┘                 └──────────────┘
```

Every tier is a sync peer running the **same merge logic**. `client→field` and
`field→cloud` are the same operation at different levels. A client with no field
server can sync directly to cloud. A field server with no internet still fully
coordinates a local operation. No tier is special-cased.

The client is fully functional standalone and offline — it never *blocks* on a
server. Servers are coordination/durability points, not gatekeepers.

## Tech Stack

- **Client:** Progressive Web App (PWA). One codebase across phone, tablet,
  laptop. Installable, offline via service worker + IndexedDB. The field server
  serves the static app + a sync endpoint.
- **Map rendering:** MapLibre GL JS (vector + raster, GPU-accelerated, native
  PMTiles support via the `pmtiles://` protocol plugin).
- **Drawing:** terra-draw for marker/line/polygon/track tools; outputs GeoJSON
  directly.
- **Local storage:** IndexedDB (feature store) + Cache Storage API (tiles, via
  service worker) + OPFS/IndexedDB for downloaded PMTiles.
- **Sync transport:** WebSocket.
- **Server:** a single shared module that runs as either the field server or the
  cloud server (sync relay + PMTiles host).

## Identity

Lightweight, no accounts:

- On first use, the client generates a stable `deviceId` (UUID, stored in
  `localStorage`).
- The user picks a **callsign** (e.g., `Team3-Mike`) when joining a map.
- Identity = `{ callsign, deviceId }`. No passwords, no auth server. Works fully
  offline.

Audit trail still works: every feature is stamped with author callsign +
deviceId + timestamps.

## Data Model

A **Feature** is a GeoJSON Feature with required properties:

```json
{
  "type": "Feature",
  "geometry": { "type": "Point | LineString | Polygon", "coordinates": [] },
  "properties": {
    "id": "uuid",             // stable, client-generated
    "author": "Team3-Mike",   // callsign string
    "authorDeviceId": "uuid", // device that owns this feature
    "createdAt": 1718000000000,
    "updatedAt": 1718000000000, // bumped on every edit
    "deleted": false,         // tombstone (soft delete)
    "kind": "marker | track | line | polygon",
    "label": "",              // user text
    "color": ""               // kind-specific styling, notes, etc.
  }
}
```

The whole-map export is plain GeoJSON:
`{ "type": "FeatureCollection", "features": [ ...non-deleted features... ] }`.

## Merge Model — OR-Set with LWW

Map state is an **OR-Set of features keyed by `id`**: an add/remove set with
tombstones. This is the simplest CRDT that fits ownership-scoped editing.

- **Add/edit:** upsert by `id`. On `id` collision (rare same-author-on-two-device
  case), **last-write-wins by `updatedAt`**; tie-break on `authorDeviceId` for
  determinism.
- **Delete:** set `deleted: true` and bump `updatedAt` (tombstone, never hard
  remove). LWW applies — a later edit can resurrect; a later delete wins over an
  earlier edit.
- **Ownership guard (client-side only):** the UI only lets you edit/delete
  features where `authorDeviceId === myDeviceId`. This is a convenience/safety
  guard, **not security** — without accounts it is not enforced server-side.
  Documented as a known limitation.

Because ownership scoping means two people cannot legitimately edit the same
feature, the merge is essentially a **union of feature sets** with LWW only as a
safety net. No vector-level CRDT, no operational transforms required.

## Sync Protocol

Tiers exchange feature sets and merge. Two transports, same payload:

- **Client ↔ Field server:** WebSocket over local WiFi. Live push when
  connected; batch reconcile on (re)connect.
- **Field ↔ Cloud:** same protocol, opportunistic when internet appears.

### Reconnect reconcile (delta-based, the core sync)

1. Peer A sends a **digest**: `{ id → updatedAt }` for all features (compact —
   just timestamps).
2. Peer B compares to its own set and replies with which `id`s it needs (A has
   newer/unknown) and which it has newer.
3. Both exchange only the **full features that changed**. Merge via LWW.

Only what changed crosses the wire — important on flaky field links. Tombstones
travel like any other feature, so deletes propagate.

### Live mode

While a WebSocket is up, each local edit also broadcasts immediately as an
`upsert` message. The reconcile handshake runs once on connect to catch up, then
live messages keep everyone current. Other clients connected to the same field
server receive relayed edits — this is the real-time collaboration piece.

### Conflict surface

Because of ownership scoping, the only LWW collisions are
same-author/two-device. Deterministic, silent, and logged.

## Tiles — Offline + Opportunistic

### Pre-downloaded (guaranteed coverage)

- Operation region packaged as a **PMTiles** file (single file: raster imagery,
  topo, or vector).
- Field server and cloud server host the `.pmtiles` over HTTP (range requests).
  MapLibre reads it via the `pmtiles://` protocol plugin.
- A client can also **download the PMTiles file to OPFS/IndexedDB** for true
  standalone offline (no field server needed). On a phone, the client may instead
  stream from the field server's copy over local WiFi rather than holding the
  whole file — chosen per device.

### Opportunistic cache-as-you-browse

- A **service worker** intercepts tile requests and caches responses (Cache
  Storage API). Anything panned over while online is available offline later —
  covering areas outside the pre-downloaded region.

### Tile priority order at render time

local PMTiles (if downloaded) → field-server PMTiles (local WiFi) →
service-worker cache → cloud/online source. Always serves the best available;
degrades gracefully offline.

## Client App Structure

Each unit is independently testable with a single clear responsibility.

| Unit | Responsibility | Depends on |
|---|---|---|
| `MapView` | MapLibre setup, PMTiles protocol, layer rendering | MapLibre, FeatureStore |
| `DrawController` | terra-draw marker/line/polygon/track tools → GeoJSON | terra-draw, FeatureStore |
| `FeatureStore` | OR-Set logic, LWW merge, ownership guard, IndexedDB persistence | IndexedDB |
| `SyncClient` | WebSocket, digest/delta reconcile, live broadcast | FeatureStore |
| `TileManager` | PMTiles download, service-worker cache priority | SW, OPFS/IndexedDB |
| `Identity` | callsign + deviceId (generated once, stored locally) | localStorage |
| `Server` (shared) | sync relay + PMTiles host; runs as field **or** cloud | FeatureStore (server copy) |

`FeatureStore` is the heart — pure merge logic with no UI or network
dependencies, so the CRDT is unit-testable in isolation. The same store module
runs on both client and server.

## Error Handling

- **Offline is normal, not an error** — no connection just means `SyncClient`
  retries with backoff; all editing continues locally.
- **Tile miss** — fall through the priority chain; if nothing is available, show
  a neutral "no tiles here" grid rather than failing.
- **Malformed sync payload** — reject that message, log it, keep the connection;
  never let one bad delta corrupt the store.
- **Storage full (tiles)** — surface a clear quota warning; the pre-downloaded
  region is protected over opportunistic cache.

## Testing Strategy

- **Unit:** `FeatureStore` merge — concurrent upserts, tombstone resurrection,
  LWW tie-breaks, ownership rejection.
- **Integration:** two in-memory stores reconcile via digest/delta and converge
  to identical state (the core correctness property).
- **E2E (Playwright):** draw a feature offline → reconnect → second client sees
  it; delete propagates; tiles render from PMTiles offline.
