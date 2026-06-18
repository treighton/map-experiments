import { FeatureStore, SyncServer, WebSocketSyncServer } from "@sartools/feature-store";

const store = new FeatureStore();
const syncServer = new SyncServer(store);
const wsServer = new WebSocketSyncServer(syncServer, { port: 8787 });
await wsServer.start();
console.log("Sync server listening on ws://localhost:8787");
