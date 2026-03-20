import { describe, it, expect } from 'vitest';
import { inferTaskCategory } from '../src/services/learning.js';

describe('debug', () => {
  it('spec check', () => {
    console.log(inferTaskCategory('Add e2e spec for dashboard'));
    console.log(inferTaskCategory('Write unit tests for auth'));
    console.log(inferTaskCategory('Something', 'We need to write unit tests'));
    console.log(inferTaskCategory('Improve test coverage in API'));
    expect(true).toBe(true);
  });
});
