import type { Context } from 'koa';
/**
 * Redis-based sliding-window rate limiter.
 *
 * Applies different limits to anonymous vs authenticated requests,
 * and tighter limits on write (POST/PUT/PATCH/DELETE) endpoints.
 */

import { getClientIp, getErrorMessage } from '../utils/common';
import { getRedis } from '../utils/redis';

interface RateLimitConfig {
  /** Max requests per window for anonymous read (GET/HEAD) */
  anonReadLimit?: number;
  /** Max requests per window for anonymous write (POST/PUT/…) */
  anonWriteLimit?: number;
  /** Max requests per window for authenticated read */
  authReadLimit?: number;
  /** Max requests per window for authenticated write */
  authWriteLimit?: number;
  /** Window size in seconds */
  windowSeconds?: number;
}

const DEFAULTS: Required<RateLimitConfig> = {
  anonReadLimit: 60,
  anonWriteLimit: 20,
  authReadLimit: 120,
  authWriteLimit: 40,
  windowSeconds: 60,
};

export default (config: RateLimitConfig, { strapi }: any) => {
  const opts = { ...DEFAULTS, ...config };

  return async (ctx: Context, next: () => Promise<void>) => {
    const method = (ctx.request.method || 'GET').toUpperCase();

    // Skip non-API and admin requests
    const path: string = ctx.request.path || '';
    if (!path.startsWith('/api/')) {
      await next();
      return;
    }

    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const userId = ctx.state?.user?.id;
    const isAuth = !!userId;

    const limit = isAuth
      ? (isWrite ? opts.authWriteLimit : opts.authReadLimit)
      : (isWrite ? opts.anonWriteLimit : opts.anonReadLimit);

    const identity = isAuth ? `u:${userId}` : `ip:${getClientIp(ctx)}`;
    const bucket = isWrite ? 'w' : 'r';
    const key = `rl:${bucket}:${identity}`;

    try {
      const redis = getRedis();
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, opts.windowSeconds);
      }

      ctx.set('X-RateLimit-Limit', String(limit));
      ctx.set('X-RateLimit-Remaining', String(Math.max(0, limit - current)));

      if (current > limit) {
        const ttl = await redis.ttl(key);
        ctx.set('Retry-After', String(ttl > 0 ? ttl : opts.windowSeconds));
        ctx.status = 429;
        ctx.body = {
          error: {
            code: 'TOO_MANY_REQUESTS',
            message: 'Rate limit exceeded. Please slow down.',
          },
        };
        return;
      }
    } catch (err: unknown) {
      // If Redis is down, let the request through (fail-open)
      strapi?.log?.warn?.(`[rate-limit] Redis error: ${getErrorMessage(err)}`);
    }

    await next();
  };
};
