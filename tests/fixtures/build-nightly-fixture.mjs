// Nightly CI helper: materializes the 100k-commit perf fixture script for the
// scheduled budget run. Kept as a separate entry point so PR smoke runs do
// not pay the build cost.
import { buildLargeRepository } from './large-repository.ts';

const path = await buildLargeRepository(100_000);
console.log(path);
