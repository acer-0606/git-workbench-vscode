import { describe, expect, it } from 'vitest';

import { registeredFutureProviders } from '@git-workbench/domain';

describe('future providers', () => {
  it('ships zero registrations in V1 by contract', () => {
    expect(registeredFutureProviders).toEqual([]);
  });
});
