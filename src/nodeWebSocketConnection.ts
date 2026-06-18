import type { Connection } from "./connection.js";

/**
 * Minimal structural type for the parts of a `ws` WebSocket the adapter uses.
 * The real `ws.WebSocket` satisfies it; using a structural type keeps this file
 * decoupled from a hard `ws` type import in its public signature.
 */
interface WsLike {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "open" | "close", handler: () => void): void;
  on(event: "error", handler: (err: unknown) => void): void;
}

/**
 * Connection backed by a Node `ws` socket. Used by the server per incoming socket
 * and as the client socket in integration tests. send() drops while not OPEN; an
 * error event is treated as a close (fired once even if close also fires). Inbound
 * Buffers are decoded to strings.
 */
export class NodeWebSocketConnection implements Connection {
  private messageHandlers: ((data: string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private closeFired = false;

  constructor(private ws: WsLike) {
    this.ws.on("message", (data: unknown) => {
      const str =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : String(data);
      for (const h of this.messageHandlers) h(str);
    });
    this.ws.on("open", () => {
      for (const h of this.openHandlers) h();
    });
    this.ws.on("close", () => this.fireClose());
    this.ws.on("error", () => this.fireClose());
  }

  private fireClose(): void {
    if (this.closeFired) return; // a socket may emit both error and close
    this.closeFired = true;
    for (const h of this.closeHandlers) h();
  }

  send(data: string): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(data);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  isOpen(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }

  close(): void {
    this.ws.close();
  }
}
