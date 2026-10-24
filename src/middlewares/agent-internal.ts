import type { Context } from 'koa';
import crypto from 'crypto';

/**
 * 校验 Agent Worker / 内部服务调用的共享密钥。
 * 与路由 config.middlewares 搭配：auth: false + global::agent-internal
 */
const timingSafeEqualStr = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Length itself is not secret, and timingSafeEqual requires equal lengths.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

export default (_config: any, { strapi }: any) => {
  return async (ctx: Context, next: () => Promise<void>) => {
    const expected = process.env.AGENT_INTERNAL_SECRET || '';
    if (!expected) {
      strapi.log.warn('[agent] AGENT_INTERNAL_SECRET is not set; internal routes disabled');
      return ctx.forbidden('agent internal not configured');
    }
    const header =
      ctx.request?.header?.['x-agent-secret'] ||
      ctx.request?.header?.['X-Agent-Secret'] ||
      '';
    if (typeof header !== 'string' || !timingSafeEqualStr(header, expected)) {
      return ctx.forbidden('invalid agent secret');
    }
    await next();
  };
};
