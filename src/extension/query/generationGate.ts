/**
 * Coalesces bursts of repository-generation changes into one refresh per
 * debounce window and trips a circuit breaker when storms persist, so a
 * pathological event source cannot pin the Extension Host with background
 * reads. `resume()` clears the tripped state for an explicit user refresh.
 */
export class GenerationGate {
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stormCount = 0;
  private tripped = false;

  constructor(
    private readonly debounceMs: number,
    private readonly stormThreshold: number,
    private readonly refresh: () => Promise<void> | void,
    private readonly schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout> = (callback, ms) => setTimeout(callback, ms),
    private readonly cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void = (timer) => clearTimeout(timer),
  ) {}

  get isPaused(): boolean {
    return this.tripped;
  }

  change(): void {
    if (this.tripped) return;
    this.stormCount += 1;
    if (this.stormCount > this.stormThreshold) {
      this.tripped = true;
      if (this.timer !== undefined) {
        this.cancelSchedule(this.timer);
        this.timer = undefined;
      }
      this.pending = false;
      return;
    }
    if (this.pending) return;
    this.pending = true;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.pending = false;
      this.stormCount = 0;
      void this.refresh();
    }, this.debounceMs);
  }

  resume(): void {
    this.tripped = false;
    this.stormCount = 0;
    this.pending = false;
    if (this.timer !== undefined) {
      this.cancelSchedule(this.timer);
      this.timer = undefined;
    }
    void this.refresh();
  }
}
