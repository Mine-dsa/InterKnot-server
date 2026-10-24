import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * addDenny 单元测试。
 * 核心断言：必须使用「有回调」的 strapi.db.transaction(cb) 形式——
 * 无回调形式会在 SQLite 单连接池上自锁死锁（全站 60s 冻结）。
 * 参考 src/utils/level.ts 与 src/utils/denny.ts 的事务说明注释。
 */

type TxCall = { hasCallback: boolean };

function makeStrapi(overrides: {
  user?: any;
  existingLog?: any;
  failAt?: 'findOneUser' | 'findLog' | 'createLog' | 'updateUser' | 'txCallback';
} = {}) {
  const txCalls: TxCall[] = [];
  const queries: Array<{ method: string; uid: string; args: any }> = [];

  const strapi: any = {
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    db: {
      // 事务桩：记录调用形态并执行回调（ALS 由真实实现负责，这里验证形态）
      transaction: vi.fn(async (cb?: (...args: unknown[]) => unknown) => {
        const hasCallback = typeof cb === 'function';
        txCalls.push({ hasCallback });
        if (!hasCallback) {
          // 模拟真实危害：无回调形式持有连接 + 不执行任何业务
          return { commit: vi.fn(), rollback: vi.fn(), get: () => ({}) };
        }
        if (overrides.failAt === 'txCallback') {
          throw new Error('tx callback failed');
        }
        return await cb();
      }),
      query: vi.fn((uid: string) => ({
        findOne: vi.fn(async (params: any) => {
          queries.push({ method: 'findOne', uid, args: params });
          if (uid === 'plugin::users-permissions.user') {
            if (overrides.failAt === 'findOneUser') throw new Error('db down');
            return overrides.user ?? null;
          }
          if (uid === 'api::denny-log.denny-log') {
            if (overrides.failAt === 'findLog') throw new Error('db down');
            return overrides.existingLog ?? null;
          }
          return null;
        }),
        create: vi.fn(async (params: any) => {
          queries.push({ method: 'create', uid, args: params });
          if (overrides.failAt === 'createLog') throw new Error('db down');
          return { id: 1 };
        }),
        update: vi.fn(async (params: any) => {
          queries.push({ method: 'update', uid, args: params });
          if (overrides.failAt === 'updateUser') throw new Error('db down');
          return { id: 1 };
        }),
      })),
    },
  };

  return { strapi, txCalls, queries };
}

const USER_OK = { denny: 100, denny_given: 0 };

let mod: typeof import('../../src/utils/denny');

beforeEach(async () => {
  mod = await import('../../src/utils/denny');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('addDenny 事务形态（死锁防回归）', () => {
  it('必须使用有回调事务：db.transaction 收到函数参数', async () => {
    const { strapi, txCalls } = makeStrapi({ user: USER_OK });
    const result = await mod.addDenny(strapi, 1, 50, 'refund');
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0].hasCallback).toBe(true); // 核心断言
    expect(result).toEqual({ newBalance: 150, added: 50, requested: 50, capped: false });
  });

  it('回调内的查询不带无效 transaction 死参数（Strapi query builder 不识别）', async () => {
    const { strapi, queries } = makeStrapi({ user: USER_OK });
    await mod.addDenny(strapi, 1, 10, 'reward');
    for (const q of queries) {
      expect(q.args).not.toHaveProperty('transaction');
    }
  });
});

describe('addDenny 业务行为', () => {
  it('用户不存在 → null，不更新不写日志', async () => {
    const { strapi, queries } = makeStrapi({ user: null });
    const result = await mod.addDenny(strapi, 999, 10, 'reward');
    expect(result).toBeNull();
    expect(queries.filter((q) => q.method !== 'findOne')).toHaveLength(0);
  });

  it('幂等：已有同 related 日志 → { existing: true, added: 0 }，不再写库', async () => {
    const { strapi, queries } = makeStrapi({
      user: USER_OK,
      existingLog: { id: 5 },
    });
    const result = await mod.addDenny(strapi, 1, 10, 'refund', undefined, 'api::article.article', 'abc');
    expect(result).toEqual({
      existing: true,
      newBalance: 100,
      added: 0,
      requested: 10,
      capped: false,
    });
    expect(queries.filter((q) => q.method === 'create')).toHaveLength(0);
    expect(queries.filter((q) => q.method === 'update')).toHaveLength(0);
  });

  it('封顶 9999：溢出部分丢弃并标记 capped', async () => {
    const { strapi } = makeStrapi({ user: { denny: 9990, denny_given: 0 } });
    const result = await mod.addDenny(strapi, 1, 100, 'reward');
    expect(result).toEqual({ newBalance: 9999, added: 9, requested: 100, capped: true });
  });

  it('已到上限 → added 0 / capped true，仍写 amount=0 日志', async () => {
    const { strapi, queries } = makeStrapi({ user: { denny: 9999, denny_given: 0 } });
    const result = await mod.addDenny(strapi, 1, 10, 'reward');
    expect(result).toEqual({ newBalance: 9999, added: 0, requested: 10, capped: true });
    expect(queries.filter((q) => q.method === 'create')).toHaveLength(1);
    expect(queries.filter((q) => q.method === 'update')).toHaveLength(0);
  });

  it('日志 amount 为实际增量（封顶后 amount=实际加值）', async () => {
    const { strapi, queries } = makeStrapi({ user: { denny: 9990, denny_given: 0 } });
    await mod.addDenny(strapi, 1, 100, 'reward', '奖励');
    const create = queries.find((q) => q.method === 'create');
    expect(create?.args.data.amount).toBe(9);
    expect(create?.args.data.balance).toBe(9999);
  });

  it('非正数金额 → null 且不开启事务', async () => {
    const { strapi, txCalls } = makeStrapi({ user: USER_OK });
    expect(await mod.addDenny(strapi, 1, 0, 'x')).toBeNull();
    expect(await mod.addDenny(strapi, 1, -5, 'x')).toBeNull();
    expect(txCalls).toHaveLength(0);
  });
});

describe('addDenny 失败路径（调用方契约：返回 null，不抛出）', () => {
  it.each([
    ['findOneUser', '查用户失败', false],
    ['createLog', '写日志失败', false],
    ['updateUser', '更新余额失败', false],
    ['txCallback', '事务回调失败', false],
    ['findLog', '幂等查询失败（仅在提供 relatedType 时触达）', true],
  ] as const)('%s → 返回 null 不向上抛', async (failAt, _label, withRelated) => {
    const { strapi } = makeStrapi({ user: USER_OK, failAt });
    const result = withRelated
      ? await mod.addDenny(strapi, 1, 50, 'refund', undefined, 'api::article.article', 'abc')
      : await mod.addDenny(strapi, 1, 50, 'refund');
    expect(result).toBeNull();
  });

  it('失败时记录 error 日志（可观测）', async () => {
    const { strapi } = makeStrapi({ user: USER_OK, failAt: 'createLog' });
    await mod.addDenny(strapi, 1, 50, 'refund');
    expect(strapi.log.error).toHaveBeenCalled();
  });
});
