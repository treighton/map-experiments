import { writable, type Readable } from "svelte/store";
import type { FeatureStore, SarFeature, FeatureCollection } from "@sartools/feature-store";

/**
 * Bridges a FeatureStore (plain observable class) to Svelte reactivity. Subscribes
 * to onChange and republishes the current non-deleted features as a Svelte store.
 * Both the map render and any UI read from `features`. `toGeoJSON()` is a snapshot
 * for feeding the MapLibre source. Call destroy() to detach.
 */
export interface MapStore {
  features: Readable<SarFeature[]>;
  toGeoJSON: () => FeatureCollection;
  destroy: () => void;
}

export function createMapStore(store: FeatureStore): MapStore {
  const features = writable<SarFeature[]>(store.list());
  const off = store.onChange(() => {
    features.set(store.list());
  });
  return {
    features: { subscribe: features.subscribe },
    toGeoJSON: () => store.toGeoJSON(),
    destroy: off,
  };
}
