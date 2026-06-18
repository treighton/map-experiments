import { describe, it, expect } from "vitest";
import { WriteScheduler } from "../src/writeScheduler.js";

/** Manual timer so tests control when the debounce fires. */
class FakeTimer {
  private fns = new Map<number, () => void>();
  private next = 1;
  setTimer = (fn: () => void, _ms: number): number => {
    const h = this.next++;
    this.fns.set(h, fn);
    return h;
  };
  clearTimer = (h: number): void => {
    this.fns.delete(h);
  };
  /** Fire all currently-armed timers (simulates the delay elapsing). */
  tick(): void {
    const pending = [...this.fns.entries()];
    this.fns.clear();
    for (const [, fn] of pending) fn();
  }
  get armed(): number {
    return this.fns.size;
  }
}

function makeScheduler(flushed: string[][], maxBatch = 500) {
  const timer = new FakeTimer();
  const scheduler = new WriteScheduler({
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    flushFn: (ids) => {
      flushed.push([...ids]);
    },
    delayMs: 200,
    maxBatch,
  });
  return { scheduler, timer };
}

describe("WriteScheduler", () => {
  it("collapses a burst of markDirty into a single flush", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    scheduler.markDirty("b");
    scheduler.markDirty("a");
    expect(flushed).toEqual([]); // nothing flushed yet
    timer.tick();
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("re-arms the timer on each markDirty (trailing debounce)", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    expect(timer.armed).toBe(1);
    scheduler.markDirty("b");
    // old timer cleared, new one armed — still exactly one armed
    expect(timer.armed).toBe(1);
  });

  it("flushes immediately when the dirty set reaches maxBatch", () => {
    const flushed: string[][] = [];
    const { scheduler } = makeScheduler(flushed, 2);
    scheduler.markDirty("a");
    expect(flushed).toEqual([]);
    scheduler.markDirty("b"); // hits maxBatch=2
    expect(flushed).toEqual([["a", "b"]]);
  });

  it("explicit flush() writes the current dirty set and cancels the timer", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    scheduler.flush();
    expect(flushed).toEqual([["a"]]);
    expect(timer.armed).toBe(0);
  });

  it("flush() with an empty dirty set does nothing", () => {
    const flushed: string[][] = [];
    const { scheduler } = makeScheduler(flushed);
    scheduler.flush();
    expect(flushed).toEqual([]);
  });

  it("markDirty after a flush starts a fresh batch", () => {
    const flushed: string[][] = [];
    const { scheduler, timer } = makeScheduler(flushed);
    scheduler.markDirty("a");
    timer.tick();
    scheduler.markDirty("b");
    timer.tick();
    expect(flushed).toEqual([["a"], ["b"]]);
  });

  it("pending reports the current dirty count", () => {
    const flushed: string[][] = [];
    const { scheduler } = makeScheduler(flushed);
    scheduler.markDirty("a");
    scheduler.markDirty("b");
    expect(scheduler.pending).toBe(2);
    scheduler.flush();
    expect(scheduler.pending).toBe(0);
  });
});
