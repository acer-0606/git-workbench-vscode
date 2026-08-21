import { describe, expect, it, vi } from 'vitest';

import { GenerationGate } from './generationGate.js';

interface FakeTimer { fire(): void; }

class FakeClock {
  readonly timers: FakeTimer[] = [];
  private readonly handles = new Map<ReturnType<typeof setTimeout>, { canceled: boolean }>();

  schedule(callback: () => void): ReturnType<typeof setTimeout> {
    const state = { canceled: false };
    const handle = state as unknown as ReturnType<typeof setTimeout>;
    this.handles.set(handle, state);
    this.timers.push({ fire: () => { if (!state.canceled) callback(); } });
    return handle;
  }

  cancel(handle: ReturnType<typeof setTimeout>): void {
    const state = this.handles.get(handle);
    if (state) state.canceled = true;
  }
}

const gateWithClock = (refresh: () => void, stormThreshold: number): { gate: GenerationGate; clock: FakeClock } => {
  const clock = new FakeClock();
  const gate = new GenerationGate(100, stormThreshold, refresh, (callback) => clock.schedule(callback), (timer) => clock.cancel(timer));
  return { gate, clock };
};

describe('GenerationGate', () => {
  it('merges a storm of changes into one debounced refresh', async () => {
    const refresh = vi.fn();
    const { gate, clock } = gateWithClock(refresh, 1_000);
    for (let index = 0; index < 100; index += 1) gate.change();
    expect(refresh).not.toHaveBeenCalled();
    expect(clock.timers).toHaveLength(1);
    clock.timers[0]?.fire();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('trips the breaker when storms persist past the threshold and resumes explicitly', async () => {
    const refresh = vi.fn();
    const { gate, clock } = gateWithClock(refresh, 10);
    for (let index = 0; index < 12; index += 1) gate.change();
    expect(gate.isPaused).toBe(true);
    for (const timer of clock.timers.splice(0)) timer.fire();
    expect(refresh).not.toHaveBeenCalled();
    gate.resume();
    expect(gate.isPaused).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
