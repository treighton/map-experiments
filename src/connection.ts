export interface Connection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onOpen(handler: () => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** Test/in-memory endpoint. `open()` simulates the transport opening. */
export interface InMemoryConnection extends Connection {
  open(): void;
}

class MemoryEndpoint implements InMemoryConnection {
  private messageHandlers: ((data: string) => void)[] = [];
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  private closed = false;
  peer: MemoryEndpoint | null = null;

  send(data: string): void {
    if (this.closed || !this.peer || this.peer.closed) return;
    // Deliver synchronously to the peer's message handlers.
    for (const h of this.peer.messageHandlers) h(data);
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

  fireOpen(): void {
    for (const h of this.openHandlers) h();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
    if (this.peer && !this.peer.closed) this.peer.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  open(): void {
    this.fireOpen();
    if (this.peer) this.peer.fireOpen();
  }
}

/**
 * Create two linked in-memory connection endpoints. A message sent on one is
 * delivered synchronously to the other's message handlers. Calling open() on
 * either fires onOpen on both; close() fires onClose on both and stops delivery.
 */
export function connectionPair(): [InMemoryConnection, InMemoryConnection] {
  const a = new MemoryEndpoint();
  const b = new MemoryEndpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
