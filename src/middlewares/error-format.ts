import type { Context } from 'koa';
// 与 Strapi 内置 errors 中间件一致的 error.name → HTTP status 映射
// 因为 global::error-format 位于 strapi::errors 内层（见 config/middlewares.ts），
// 会先于 Strapi 内置中间件捕获 @strapi/utils 抛出的命名错误，错误对象上没有 status 字段，
// 必须在这里按 name 推断状态码，否则 ValidationError / UnauthorizedError 等都会被当成 500。
const STATUS_BY_ERROR_NAME: Record<string, number> = {
  ValidationError: 400,
  ApplicationError: 400,
  YupValidationError: 400,
  PaginationError: 400,
  UnauthorizedError: 401,
  ForbiddenError: 403,
  NotFoundError: 404,
  RateLimitError: 429,
  PayloadTooLargeError: 413,
  NotImplementedError: 501,
};

export default (config: any, { strapi }: any) => {
  return async (ctx: Context, next: () => Promise<void>) => {
    ctx.fail = (
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>
    ) => {
      ctx.status = status;
      ctx.body = {
        error: {
          code,
          message,
          details: details || undefined,
        },
      };
    };

    try {
      await next();
    } catch (err: unknown) {
      const e = err as {
        status?: unknown;
        statusCode?: unknown;
        name?: unknown;
        code?: unknown;
        message?: unknown;
        details?: unknown;
        data?: unknown;
      };
      const messageTranslations: Record<string, string> = {
        'Invalid identifier or password': '账号或密码错误',
        'Your account email is not confirmed': '账号邮箱未验证',
        'Your account has been blocked by an administrator': '账号已被管理员禁用',
        'Missing or invalid credentials': '缺少或无效的登录凭证',
      };

      const rawStatus =
        e?.status ??
        e?.statusCode ??
        (typeof e?.name === 'string' ? STATUS_BY_ERROR_NAME[e.name] : undefined) ??
        500;
      const status = Number(rawStatus);
      const safeStatus = Number.isFinite(status) ? status : 500;

      const code =
        typeof e?.code === 'string' && e.code
          ? e.code
          : typeof e?.name === 'string' && e.name
            ? e.name
            : safeStatus >= 500
              ? 'INTERNAL_SERVER_ERROR'
              : 'REQUEST_ERROR';

      const message =
        typeof e?.message === 'string' && e.message
          ? messageTranslations[e.message] || e.message
          : safeStatus >= 500
            ? 'Internal server error'
            : 'Request failed';

      const details =
        e?.details && typeof e.details === 'object'
          ? e.details
          : e?.data && typeof e.data === 'object'
            ? e.data
            : undefined;

      if (safeStatus >= 500) {
        strapi?.log?.error(err);
      }

      ctx.fail(safeStatus, code, message, details);
    }

    if (ctx.status && ctx.status >= 400) {
      if (ctx.body && typeof ctx.body === 'object' && (ctx.body as { error?: unknown }).error)
        return;
      if (typeof ctx.body === 'string' && ctx.body.trim()) {
        ctx.fail(ctx.status, 'REQUEST_ERROR', ctx.body.trim());
      }
    }
  };
};
