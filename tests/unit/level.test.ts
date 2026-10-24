import { describe, expect, it } from 'vitest';
import { calculateLevel } from '../../src/utils/level';

describe('calculateLevel', () => {
  it('clamps negative exp to level 1', () => {
    expect(calculateLevel(-100)).toBe(1);
  });

  it('maps threshold boundaries to the right level', () => {
    expect(calculateLevel(0)).toBe(1);
    expect(calculateLevel(499)).toBe(1);
    expect(calculateLevel(500)).toBe(2);
    expect(calculateLevel(2000)).toBe(3);
    expect(calculateLevel(6000)).toBe(4);
    expect(calculateLevel(15000)).toBe(5);
    expect(calculateLevel(35000)).toBe(6);
    expect(calculateLevel(80000)).toBe(7);
  });

  it('caps at the top level (7) above the highest threshold', () => {
    expect(calculateLevel(10_000_000)).toBe(7);
  });
});
