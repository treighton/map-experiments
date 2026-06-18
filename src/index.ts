export * from "./types.js";
export { newId } from "./uuid.js";
export { mergeFeature, mergeAll } from "./merge.js";
export {
  FeatureStore,
  type CreateInput,
  type EditableFields,
  type StoreDeps,
} from "./featureStore.js";
export {
  loadOrCreateIdentity,
  type KeyValueStore,
} from "./identity.js";
