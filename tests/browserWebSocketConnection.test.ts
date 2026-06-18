import { describe, it, expect } from "vitest";
import { BrowserWebSocketConnection } from "../src/browserWebSocketConnection.js";

/** Fake browser WebSocket mimicking the surface the adapter uses. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }
  fireOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  fireMessage(data: string) {
    this.onmessage?.({ data });
  }
  fireClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function makeConn() {
  const ws = new FakeWebSocket();
  const conn = new BrowserWebSocketConnection("ws://x", () => ws as unknown as never);
  return { ws, conn };
}

describe("BrowserWebSocketConnection", () => {
  it("isOpen() reflects readyState", () => {
    const { ws, conn } = makeConn();
    expect(conn.isOpen()).toBe(false);
    ws.fireOpen();
    expect(conn.isOpen()).toBe(true);
  });

  it("fires onOpen handlers when the socket opens", () => {
    const { ws, conn } = makeConn();
    let opened = false;
    conn.onOpen(() => (opened = true));
    ws.fireOpen();
    expect(opened).toBe(true);
  });

  it("delivers inbound messages to onMessage handlers", () => {
    const { ws, conn } = makeConn();
    const got: string[] = [];
    conn.onMessage((d) => got.push(d));
    ws.fireMessage("hello");
    expect(got).toEqual(["hello"]);
  });

  it("send() drops while CONNECTING and sends when OPEN", () => {
    const { ws, conn } = makeConn();
    conn.send("early");
    expect(ws.sent).toEqual([]);
    ws.fireOpen();
    conn.send("now");
    expect(ws.sent).toEqual(["now"]);
  });

  it("fires onClose handlers and close() closes the socket", () => {
    const { ws, conn } = makeConn();
    let closed = false;
    conn.onClose(() => (closed = true));
    ws.fireClose();
    expect(closed).toBe(true);
    conn.close();
    expect(ws.closed).toBe(true);
  });
});
