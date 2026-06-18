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
    if (this.wss) {
      return Promise.reject(new Error("WebSocketSyncServer already started"));
    }
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.opts.port });
      this.wss = wss;
      let listening = false;
      wss.on("connection", (socket: WebSocket) => {
        this.syncServer.accept(new NodeWebSocketConnection(socket));
      });
      wss.on("listening", () => {
        listening = true;
        resolve();
      });
      wss.on("error", (err) => {
        if (listening) {
          // A runtime error after the server is up: log it (the start promise
          // has already resolved, so rejecting it would be a silent no-op).
          console.error("WebSocketSyncServer error:", err);
        } else {
          // A listen failure (e.g. EADDRINUSE): surface it to the caller.
          reject(err);
        }
      });
    });
  }

  /** Stop listening, terminate connected sockets, and close the server. */
  stop(): Promise<void> {
    const wss = this.wss;
    this.wss = null;
    if (!wss) return Promise.resolve();
    return new Promise((resolve) => {
      // close() stops accepting and waits for sockets to drain; terminate open
      // client sockets first so it cannot hang on still-connected clients.
      for (const socket of wss.clients) socket.terminate();
      wss.close(() => resolve());
    });
  }
}
