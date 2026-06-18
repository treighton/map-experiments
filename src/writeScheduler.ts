export type TimerHandle = number;

export interface SchedulerDeps {
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  clearTimer: (h: TimerHandle) => void;
  flushFn: (ids: readonly string[]) => void | Promise<void>;
  delayMs?: number;
  maxBatch?: number;
}

/**
 * Accumulates dirty ids and flushes them as a batch after a quiet window
 * (trailing debounce) or when the batch reaches maxBatch. Pure: all timing is
 * injected via setTimer/clearTimer so tests drive it deterministically.
 */
export class WriteScheduler {
  private dirty = new Set<string>();
  private timer: TimerHandle | null = null;
  private readonly setTimer: SchedulerDeps["setTimer"];
  private readonly clearTimer: SchedulerDeps["clearTimer"];
  private readonly flushFn: SchedulerDeps["flushFn"];
  private readonly delayMs: number;
  private readonly maxBatch: number;

  constructor(deps: SchedulerDeps) {
    this.setTimer = deps.setTimer;
    this.clearTimer = deps.clearTimer;
    this.flushFn = deps.flushFn;
    this.delayMs = deps.delayMs ?? 200;
    this.maxBatch = deps.maxBatch ?? 500;
  }

  get pending(): number {
    return this.dirty.size;
  }

  markDirty(id: string): void {
    this.dirty.add(id);
    if (this.dirty.size >= this.maxBatch) {
      this.flush();
      return;
    }
    this.arm();
  }

  flush(): void {
    this.cancelTimer();
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    void this.flushFn(ids);
  }

  private arm(): void {
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
