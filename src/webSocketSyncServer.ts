import { WebSocketServer, type WebSocket } from "ws";
import type { SyncServer } from "./syncServer.js";
import { NodeWebSocketConnection } from "./nodeWebSocketConnection.js";

export interface WebSocketSyncServerOptions {
  port: number;
}

/**
 * Node `ws.Server` listener that feeds each incoming socket to SyncServer.accept
 * (wrapped in a NodeWebSocketConnection). The SyncServer holds the shared store
 * and relays among connected clients. Real WebSocket listening; the protocol and
 * relay logic live in SyncServer.
 */
export class WebSocketSyncServer {
  private wss: WebSocketServer | null = null;

  constructor(
    private syncServer: SyncServer,
    private opts: WebSocketSyncServerOptions,
  ) {}

  /** Begin listening. Resolves once listening; rejects on a listen error. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port });
      this.wss = wss;
      wss.on("connection", (socket: WebSocket) => {
        this.syncServer.accept(new NodeWebSocketConnection(socket));
      });
      wss.on("listening", () => resolve());
      wss.on("error", (err) => reject(err));
    });
  }

  /** Stop listening and close all sockets. */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
      this.wss = null;
    });
  }
}
