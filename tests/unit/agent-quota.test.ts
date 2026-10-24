import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存版 Redis 替身，覆盖 quota 用到的命令。 */
class FakeRedis {
  store = new Map<string, number>();
  expires = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? String(this.store.get(key)) : null;
  }
  async incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }
  async incrby(key: string, by: number): Promise<number> {
    const next = (this.store.get(key) ?? 0) + by;
    this.store.set(key, next);
    return next;
  }
  async expire(key: string, ttl: number): Promise<number> {
    this.expires.set(key, ttl);
    return 1;
  }
}

let fake: FakeRedis;

vi.mock('../../src/utils/redis', () => ({
  getRedis: () => fake,
}));

import { addTokenUsage, checkQuota } from '../../src/utils/agent/quota';

const strapi = { log: { warn: () => {} } } as any;

beforeEach(() => {
  fake = new FakeRedis();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('checkQuota', () => {
  it('allows when no limits configured', async () => {
    const d = await checkQuota(strapi, 1, {});
    expect(d.allowed).toBe(true);
  });

  it('allows up to the reply limit then blocks', async () => {
    const limits = { dailyRepliesPerUser: 2 };
    expect((await checkQuota(strapi, 7, limits)).allowed).toBe(true);
    expect((await checkQuota(strapi, 7, limits)).allowed).toBe(true);
    const third = await checkQuota(strapi, 7, limits);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('daily_reply_limit_exceeded');
  });

  it('sets a TTL on first reply increment', async () => {
    await checkQuota(strapi, 9, { dailyRepliesPerUser: 5 });
    expect([...fake.expires.values()].some((t) => t === 86_400)).toBe(true);
  });

  it('blocks when daily token budget already exceeded', async () => {
    await addTokenUsage(strapi, 3, 1000);
    const d = await checkQuota(strapi, 3, { dailyTokenBudget: 500, dailyRepliesPerUser: 50 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('daily_token_budget_exceeded');
  });

  it('does not consume a reply slot when token budget is exceeded', async () => {
    await addTokenUsage(strapi, 4, 1000);
    await checkQuota(strapi, 4, { dailyTokenBudget: 500, dailyRepliesPerUser: 1 });
    const replyKeys = [...fake.store.keys()].filter((k) => k.includes(':replies:'));
    expect(replyKeys.length).toBe(0);
  });

  it('ignores non-integer userId', async () => {
    const d = await checkQuota(strapi, NaN as unknown as number, { dailyRepliesPerUser: 1 });
    expect(d.allowed).toBe(true);
  });
});

describe('addTokenUsage', () => {
  it('accumulates token usage', async () => {
    await addTokenUsage(strapi, 5, 100);
    await addTokenUsage(strapi, 5, 50);
    const key = [...fake.store.keys()].find((k) => k.includes(':tokens:'))!;
    expect(fake.store.get(key)).toBe(150);
  });

  it('ignores non-positive token counts', async () => {
    await addTokenUsage(strapi, 5, 0);
    await addTokenUsage(strapi, 5, -10);
    expect(fake.store.size).toBe(0);
  });
});
