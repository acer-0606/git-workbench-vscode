export async function measureP95<T>(times: number, run: () => Promise<T>): Promise<number> {
  const durations: number[] = [];
  for (let index = 0; index < times; index += 1) {
    const started = performance.now();
    await run();
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const index = Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1);
  return durations[Math.max(0, index)]!;
}
