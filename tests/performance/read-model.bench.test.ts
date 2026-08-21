import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { openPreparedRepository } from '../fixtures/large-repository.js';
import { measureP95 } from '../support/measure.js';

// The full 100k-commit budget runs in the nightly job with
// GIT_WORKBENCH_PERF_REPO set; local and PR runs use the deterministic smoke
// fixture instead of fabricating numbers.
const preparedPath = process.env.GIT_WORKBENCH_PERF_REPO;
const timeoutMs = preparedPath ? 120_000 : 300_000;

describe('read model performance budget', () => {
  let repository: Awaited<ReturnType<typeof openPreparedRepository>>;

  beforeAll(async () => {
    repository = await openPreparedRepository(preparedPath);
  }, timeoutMs);

  afterAll(async () => {
    await repository.dispose();
  });

  it('loads the first 200 commits within the local P95 budget', async () => {
    const p95 = await measureP95(20, () => repository.logPage({ limit: 200 }));
    expect(p95).toBeLessThan(1_000);
  }, timeoutMs);
});
