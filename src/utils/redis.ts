import Redis from 'ioredis';

let client: Redis | null = null;
let mockClient: any = null;

function createMockRedis() {
  if (mockClient) return mockClient;

  // 内存 KV 存储：让 ticket 类一次性凭证（DM WS / knock SSE）在无 Redis 的
  // 本地分发形态下真实可用。仅覆盖 KV 语义（set/get/getdel/del/exists/incr），
  // List / PubSub 等仍为空实现（agent 队列等明确依赖真实 Redis 的功能不降级）。
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const isLive = (entry: { expiresAt: number | null }) =>
    entry.expiresAt === null || entry.expiresAt > Date.now();
  const sweep = (key: string) => {
    const entry = store.get(key);
    if (entry && !isLive(entry)) store.delete(key);
  };

  mockClient = {
    set: (key: string, value: string, ...rest: unknown[]) => {
      // 兼容 ioredis 的 set(key, val, 'EX', ttlSec) 签名
      let expiresAt: number | null = null;
      if (rest[0] === 'EX') {
        const ttl = Number(rest[1]);
        if (ttl > 0) expiresAt = Date.now() + ttl * 1000;
      } else if (rest[0] === 'PX') {
        const ttl = Number(rest[1]);
        if (ttl > 0) expiresAt = Date.now() + ttl;
      } else if (rest[0] === 'KEEPTTL') {
        expiresAt = store.get(key)?.expiresAt ?? null;
      }
      store.set(key, { value: String(value), expiresAt });
      return Promise.resolve('OK');
    },
    get: (key: string) => {
      sweep(key);
      const entry = store.get(key);
      return Promise.resolve(entry && isLive(entry) ? entry.value : null);
    },
    getdel: (key: string) => {
      sweep(key);
      const entry = store.get(key);
      if (entry && isLive(entry)) {
        store.delete(key);
        return Promise.resolve(entry.value);
      }
      return Promise.resolve(null);
    },
    del: (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        if (store.delete(k)) n += 1;
      }
      return Promise.resolve(n);
    },
    exists: (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        sweep(k);
        if (store.has(k)) n += 1;
      }
      return Promise.resolve(n);
    },
    setex: (key: string, ttl: number, value: string) => {
      store.set(key, { value: String(value), expiresAt: Date.now() + ttl * 1000 });
      return Promise.resolve('OK');
    },
    expire: (key: string, ttl: number) => {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(0);
      entry.expiresAt = Date.now() + ttl * 1000;
      return Promise.resolve(1);
    },
    // 计数器类保持恒定返回（与原 mock 行为一致）：本仓库内 incr/incrby 的消费方
    // 全部是频率限制 / 配额计数（rate-limit / agent-quota / author 搜索限流 /
    // dm 发送限流 / 浏览计数）。无 Redis 的本地形态下这些功能本就不可用/形同虚设，
    // 这里不因 mock KV 的真实化而意外激活频率限制语义。
    incr: () => Promise.resolve(1),
    incrby: (_key: string, by: number) => Promise.resolve(by),
    lpush: () => Promise.resolve(1),
    lrange: () => Promise.resolve([]),
    on: () => {},
  };

  return mockClient;
}

export const getRedis = (): Redis => {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[redis] REDIS_URL not set, using mock (Redis features disabled)');
    return createMockRedis() as unknown as Redis;
  }

  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        return Math.min(times * 200, 5000);
      },
      lazyConnect: true,
    });

    client.on('error', (err) => {
      console.error('[redis] error:', err?.message);
    });
    client.on('connect', () => {
      console.log('[redis] connected');
    });

    return client;
  } catch (err) {
    console.warn('[redis] failed to create client, using mock:', err);
    return createMockRedis() as unknown as Redis;
  }
};
