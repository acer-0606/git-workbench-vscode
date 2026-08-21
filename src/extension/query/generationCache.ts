interface Entry<T> { readonly generation: number; readonly value: T; readonly bytes: number; touched: number }

/**
 * Byte-bounded LRU keyed by `repositoryGeneration + queryKey`: a cached value
 * from a stale repository generation is never returned. Touch order uses a
 * monotonic counter so entries created in the same millisecond stay ordered.
 */
export class GenerationCache {
  private readonly values = new Map<string, Entry<unknown>>();
  private used = 0;
  private clock = 0;

  constructor(private readonly maxBytes: number) {}

  get<T>(key: string, generation: number): T | undefined {
    const entry = this.values.get(key);
    if (!entry || entry.generation !== generation) return undefined;
    entry.touched = ++this.clock;
    return entry.value as T;
  }

  set<T>(key: string, generation: number, value: T, bytes: number): void {
    const previous = this.values.get(key);
    if (previous) this.used -= previous.bytes;
    this.values.set(key, { generation, value, bytes, touched: ++this.clock });
    this.used += bytes;
    const candidates = [...this.values.entries()].sort((a, b) => a[1].touched - b[1].touched);
    for (const [candidate, entry] of candidates) {
      if (this.used <= this.maxBytes) break;
      this.values.delete(candidate);
      this.used -= entry.bytes;
    }
  }
}
