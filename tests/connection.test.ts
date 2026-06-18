import { describe, it, expect } from "vitest";
import { connectionPair } from "../src/connection.js";

describe("connectionPair", () => {
  it("delivers a message sent on one endpoint to the other", () => {
    const [a, b] = connectionPair();
    const received: string[] = [];
    b.onMessage((data) => received.push(data));
    a.send("hello");
    expect(received).toEqual(["hello"]);
  });

  it("is bidirectional", () => {
    const [a, b] = connectionPair();
    const atB: string[] = [];
    const atA: string[] = [];
    b.onMessage((d) => atB.push(d));
    a.onMessage((d) => atA.push(d));
    a.send("to-b");
    b.send("to-a");
    expect(atB).toEqual(["to-b"]);
    expect(atA).toEqual(["to-a"]);
  });

  it("fires onOpen for both endpoints when opened", () => {
    const [a, b] = connectionPair();
    let aOpen = false;
    let bOpen = false;
    a.onOpen(() => (aOpen = true));
    b.onOpen(() => (bOpen = true));
    a.open();
    expect(aOpen).toBe(true);
    expect(bOpen).toBe(true);
  });

  it("fires onClose on both endpoints and stops delivering after close", () => {
    const [a, b] = connectionPair();
    let aClosed = false;
    let bClosed = false;
    a.onClose(() => (aClosed = true));
    b.onClose(() => (bClosed = true));
    const received: string[] = [];
    b.onMessage((d) => received.push(d));
    a.close();
    expect(aClosed).toBe(true);
    expect(bClosed).toBe(true);
    a.send("after-close"); // swallowed, not delivered
    expect(received).toEqual([]);
  });

  it("handles a handler that sends back synchronously without unbounded recursion", () => {
    const [a, b] = connectionPair();
    const atA: string[] = [];
    let bReplies = 0;
    a.onMessage((d) => atA.push(d));
    b.onMessage(() => {
      // Reply exactly once to avoid an intentional infinite ping-pong.
      if (bReplies < 1) {
        bReplies++;
        b.send("pong");
      }
    });
    a.send("ping");
    expect(atA).toEqual(["pong"]);
  });

  it("isOpen() is false before open() and true after", () => {
    const [a, b] = connectionPair();
    expect(a.isOpen()).toBe(false);
    expect(b.isOpen()).toBe(false);
    a.open();
    expect(a.isOpen()).toBe(true);
    expect(b.isOpen()).toBe(true);
  });

  it("isOpen() is false after close()", () => {
    const [a, b] = connectionPair();
    a.open();
    expect(a.isOpen()).toBe(true);
    a.close();
    expect(a.isOpen()).toBe(false);
    expect(b.isOpen()).toBe(false);
  });
});
