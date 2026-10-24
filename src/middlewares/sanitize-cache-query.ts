import type { Context } from 'koa';
/**
 * Strips unknown query parameters from cacheable GET routes
 * to prevent cache key pollution attacks.
 *
 * Must run BEFORE the strapi-cache middleware.
 */

const ROUTE_ALLOWED_PARAMS: [string, string[]][] = [
  ['/api/articles/list', ['start', 'limit', 'category', 'feed']],
  ['/api/articles/search', ['q', 'start', 'limit', 'category']],
  ['/api/articles/detail/', []], // documentId in path, no query params
  ['/api/comments/list', ['article', 'start', 'limit']],
  ['/api/comments/count', ['article']],
  // 注：更具体的 /api/authors/search 必须排在 /api/authors/ 之前，
  // 否则前缀匹配会先撞上后者，导致 q 参数被当成"未知参数"剥离。
  ['/api/authors/search', ['q', 'limit']],
  ['/api/authors/', ['start', 'limit']],
  ['/api/article-reads', ['start', 'limit']],
];

export default (_config: any, { strapi }: any) => {
  return async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.request.method !== 'GET') {
      await next();
      return;
    }

    const pathname: string = ctx.request.path || '';
    let matched: string[] | null = null;

    for (const [prefix, allowed] of ROUTE_ALLOWED_PARAMS) {
      if (pathname.startsWith(prefix)) {
        matched = allowed;
        break;
      }
    }

    if (matched !== null) {
      const raw: Record<string, unknown> = ctx.query || {};
      const keys = Object.keys(raw);
      const hasJunk = keys.some((k) => !matched!.includes(k));

      if (hasJunk) {
        const filtered: string[] = [];
        for (const key of matched) {
          const val = raw[key];
          if (val !== undefined && val !== null) {
            filtered.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
          }
        }
        const qs = filtered.length > 0 ? `?${filtered.join('&')}` : '';
        ctx.request.url = `${pathname}${qs}`;
      }
    }

    await next();
  };
};
