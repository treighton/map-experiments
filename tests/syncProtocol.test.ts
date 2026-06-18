import { describe, it, expect } from "vitest";
import { idsNeeded } from "../src/syncProtocol.js";

describe("idsNeeded", () => {
  it("requests ids the remote has that the local lacks", () => {
    expect(idsNeeded({}, { a: 1, b: 2 }).sort()).toEqual(["a", "b"]);
  });

  it("requests ids the remote has newer", () => {
    expect(idsNeeded({ a: 1 }, { a: 2 })).toEqual(["a"]);
  });

  it("does not request ids the local has newer or equal", () => {
    expect(idsNeeded({ a: 2 }, { a: 2 })).toEqual([]);
    expect(idsNeeded({ a: 3 }, { a: 2 })).toEqual([]);
  });

  it("ignores local-only ids", () => {
    expect(idsNeeded({ a: 1, b: 1 }, { a: 1 })).toEqual([]);
  });
});
