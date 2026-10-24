import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePagination,
  withSmallWebp,
  formatLocalDate,
  extractRelationId,
  getClientIp,
} from '../../src/utils/common';

describe('parsePagination', () => {
  it('returns defaults for non-numeric input', () => {
    expect(parsePagination(undefined, undefined)).toEqual({ start: 0, limit: 20 });
    expect(parsePagination('abc', 'xyz')).toEqual({ start: 0, limit: 20 });
  });

  it('clamps negative start to 0 and sub-1 limit to default', () => {
    expect(parsePagination(-5, 0)).toEqual({ start: 0, limit: 20 });
  });

  it('caps limit at maxLimit', () => {
    expect(parsePagination(10, 999)).toEqual({ start: 10, limit: 50 });
    expect(parsePagination(0, 999, 100)).toEqual({ start: 0, limit: 100 });
  });

  it('parses valid string numbers', () => {
    expect(parsePagination('40', '15')).toEqual({ start: 40, limit: 15 });
  });
});

describe('withSmallWebp', () => {
  it('passes through nullish media', () => {
    expect(withSmallWebp(null)).toBeNull();
    expect(withSmallWebp(undefined)).toBeUndefined();
  });

  it('appends -small.webp suffix to url', () => {
    expect(withSmallWebp({ url: '/uploads/a.png', width: 1 })).toEqual({
      url: '/uploads/a.png-small.webp',
      width: 1,
    });
  });

  it('is idempotent (does not double-append)', () => {
    const once = withSmallWebp({ url: '/uploads/a.png' });
    expect(withSmallWebp(once)).toEqual(once);
  });

  it('leaves media without a url untouched', () => {
    expect(withSmallWebp({ width: 10 })).toEqual({ width: 10 });
  });
});

describe('formatLocalDate', () => {
  it('zero-pads month and day', () => {
    expect(formatLocalDate(new Date(2026, 0, 3))).toBe('2026-01-03');
    expect(formatLocalDate(new Date(2026, 11, 25))).toBe('2026-12-25');
  });
});

describe('extractRelationId', () => {
  it('handles raw number, object id, and connect form', () => {
    expect(extractRelationId(7)).toBe(7);
    expect(extractRelationId({ id: 7 })).toBe(7);
    expect(extractRelationId({ connect: [9] })).toBe(9);
    expect(extractRelationId({ connect: [{ id: 11 }] })).toBe(11);
  });

  it('returns null for unsupported / empty values', () => {
    expect(extractRelationId(null)).toBeNull();
    expect(extractRelationId({})).toBeNull();
    expect(extractRelationId({ connect: [] })).toBeNull();
  });
});

describe('getClientIp', () => {
  const ORIGINAL = process.env.TRUSTED_PROXY_HOPS;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = ORIGINAL;
  });

  const ctx = (xff?: string, socket = '10.0.0.1') => ({
    request: {
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      socket: { remoteAddress: socket },
    },
  });

  it('reads the rightmost trusted entry (1 hop, the default)', () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    // client spoofs 1.1.1.1; real proxy appends 9.9.9.9 on the right
    expect(getClientIp(ctx('1.1.1.1, 9.9.9.9'))).toBe('9.9.9.9');
  });

  it('honours TRUSTED_PROXY_HOPS=2', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    expect(getClientIp(ctx('1.1.1.1, 8.8.8.8, 9.9.9.9'))).toBe('8.8.8.8');
  });

  it('falls back to the socket peer when hops=0', () => {
    process.env.TRUSTED_PROXY_HOPS = '0';
    expect(getClientIp(ctx('1.1.1.1, 9.9.9.9'))).toBe('10.0.0.1');
  });

  it('falls back to the socket peer when no XFF header is present', () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    expect(getClientIp(ctx(undefined))).toBe('10.0.0.1');
  });
});
