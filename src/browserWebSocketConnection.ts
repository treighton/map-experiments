import type { Connection } from "./connection.js";

/**
 * Minimal local declaration of the browser WebSocket surface the adapter uses.
 * Keeps the package's Node-oriented tsconfig free of lib.dom while staying
 * dependency-free for the browser path.
 */
interface MinimalWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

const OPEN = 1;

/**
 * Connection backed by the browser's native WebSocket. Dependency-free: it uses
 * the ambient WebSocket global (overridable via the factory arg for tests).
 * send() drops while not OPEN, matching the in-memory Connection contract.
 */
export class BrowserWebSocketConnection implements Connection {
  private ws: MinimalWebSocket;
  private messageHandlers: ((data: string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  constructor(url: string, factory?: (url: string) => MinimalWebSocket) {
    const make =
      factory ??
      ((u: string) =>
        new (globalThis as unknown as { WebSocket: new (u: string) => MinimalWebSocket }).WebSocket(u));
    this.ws = make(url);
    this.ws.onopen = () => {
      for (const h of this.openHandlers) h();
    };
    this.ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      for (const h of this.messageHandlers) h(data);
    };
    this.ws.onclose = () => {
      for (const h of this.closeHandlers) h();
    };
  }

  send(data: string): void {
    if (this.ws.readyState !== OPEN) return;
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
    return this.ws.readyState === OPEN;
  }

  close(): void {
    this.ws.close();
  }
}
