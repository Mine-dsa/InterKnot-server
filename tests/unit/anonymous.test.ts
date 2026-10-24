import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_NAME_PREFIX,
  buildAnonymousName,
  buildAnonymousAuthor,
  generateAnonymousSeed,
  shouldAnonymize,
} from '../../src/utils/anonymous';

describe('generateAnonymousSeed', () => {
  it('produces a 32-char hex string (16 random bytes)', () => {
    const seed = generateAnonymousSeed();
    expect(seed).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is effectively unique across calls', () => {
    expect(generateAnonymousSeed()).not.toBe(generateAnonymousSeed());
  });
});

describe('buildAnonymousName', () => {
  it('is deterministic for the same seed', () => {
    expect(buildAnonymousName('seed-a')).toBe(buildAnonymousName('seed-a'));
  });

  it('differs for different seeds and uses the prefix + 4 hex chars', () => {
    const name = buildAnonymousName('seed-a');
    expect(name.startsWith(`${ANONYMOUS_NAME_PREFIX}#`)).toBe(true);
    expect(name).toMatch(/#[0-9A-F]{4}$/);
    expect(buildAnonymousName('seed-a')).not.toBe(buildAnonymousName('seed-b'));
  });

  it('falls back to a stable placeholder when seed is missing', () => {
    expect(buildAnonymousName(null)).toBe(buildAnonymousName(undefined));
    expect(buildAnonymousName('')).toBe(buildAnonymousName(null));
  });
});

describe('buildAnonymousAuthor', () => {
  it('nulls out identity fields and only exposes the anonymous name', () => {
    const author = buildAnonymousAuthor('seed-a');
    expect(author).toEqual({
      documentId: null,
      name: buildAnonymousName('seed-a'),
      avatar: null,
      level: null,
    });
  });
});

describe('shouldAnonymize', () => {
  it('anonymizes whenever the post is anonymous, regardless of viewer/owner', () => {
    expect(shouldAnonymize(true, 1, 1)).toBe(true);
    expect(shouldAnonymize(true, 1, 2)).toBe(true);
    expect(shouldAnonymize(false, 1, 2)).toBe(false);
    expect(shouldAnonymize(undefined)).toBe(false);
  });
});
