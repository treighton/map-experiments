import { describe, it, expect } from "vitest";
import { NodeWebSocketConnection } from "../src/nodeWebSocketConnection.js";

/** Fake `ws` socket: EventEmitter-ish .on() + readyState + send/close. */
class FakeWsSocket {
  static OPEN = 1;
  OPEN = FakeWsSocket.OPEN;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, ((arg?: unknown, arg2?: unknown) => void)[]> = {};
  on(event: string, handler: (arg?: unknown, arg2?: unknown) => void) {
    (this.handlers[event] ??= []).push(handler);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(event: string, arg?: unknown) {
    // Real ws calls message handlers with (data, isBinary); pass a second arg to
    // match. The adapter ignores isBinary.
    for (const h of this.handlers[event] ?? []) h(arg, false as unknown);
  }
  fireOpen() {
    this.readyState = FakeWsSocket.OPEN;
    this.emit("open");
  }
}

function makeConn() {
  const ws = new FakeWsSocket();
  const conn = new NodeWebSocketConnection(ws as never);
  return { ws, conn };
}

describe("NodeWebSocketConnection", () => {
  it("isOpen() reflects readyState", () => {
    const { ws, conn } = makeConn();
    expect(conn.isOpen()).toBe(false);
    ws.fireOpen();
    expect(conn.isOpen()).toBe(true);
  });

  it("fires onOpen when the socket opens", () => {
    const { ws, conn } = makeConn();
    let opened = false;
    conn.onOpen(() => (opened = true));
    ws.fireOpen();
    expect(opened).toBe(true);
  });

  it("delivers inbound messages (Buffer or string) as strings", () => {
    const { ws, conn } = makeConn();
    const got: string[] = [];
    conn.onMessage((d) => got.push(d));
    ws.emit("message", Buffer.from("from-buffer"));
    ws.emit("message", "from-string");
    expect(got).toEqual(["from-buffer", "from-string"]);
  });

  it("send() drops while not OPEN and sends when OPEN", () => {
    const { ws, conn } = makeConn();
    conn.send("early");
    expect(ws.sent).toEqual([]);
    ws.fireOpen();
    conn.send("now");
    expect(ws.sent).toEqual(["now"]);
  });

  it("treats an error event as a close", () => {
    const { ws, conn } = makeConn();
    let closed = 0;
    conn.onClose(() => closed++);
    ws.emit("error", new Error("boom"));
    expect(closed).toBe(1);
  });

  it("fires onClose on close event and close() closes the socket", () => {
    const { ws, conn } = makeConn();
    let closed = 0;
    conn.onClose(() => closed++);
    ws.emit("close");
    expect(closed).toBe(1);
    conn.close();
    expect(ws.closed).toBe(true);
  });

  it("does not double-fire onClose when both error and close occur", () => {
    const { ws, conn } = makeConn();
    let closed = 0;
    conn.onClose(() => closed++);
    ws.emit("error", new Error("boom"));
    ws.emit("close");
    expect(closed).toBe(1); // only once
  });

  it("fires onOpen on a microtask if the socket is already open at wrap time", async () => {
    const ws = new FakeWsSocket();
    ws.readyState = FakeWsSocket.OPEN; // already open (server-side scenario)
    const conn = new NodeWebSocketConnection(ws as never);
    let opened = false;
    conn.onOpen(() => (opened = true));
    expect(opened).toBe(false); // not synchronous — caller registers handler first
    await Promise.resolve(); // let the microtask run
    expect(opened).toBe(true);
  });

  it("drops a non-text (non-Buffer non-string) message frame", () => {
    const { ws, conn } = makeConn();
    ws.fireOpen();
    const got: string[] = [];
    conn.onMessage((d) => got.push(d));
    ws.emit("message", new ArrayBuffer(4)); // not a string, not a Buffer
    expect(got).toEqual([]); // dropped, not "[object ArrayBuffer]"
  });
});
