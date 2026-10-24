import type { Context } from 'koa';
/**
 * require-auth middleware
 *
 * 与 `optional-auth` 互补：在 `auth: false` 的路由上启用此 middleware，会强制
 * 解析 JWT 并填充 ctx.state.user；缺失或无效则直接 401 返回。
 *
 * 设计目的：
 * 用于 DM 私聊这类「业务 controller 内部已自行 ctx.state.user + 成员关系
 * 检查」的端点。这些端点无需 Strapi user-permissions 插件按 controller.action
 * 自动推断 scope（admin UI 上经常漏勾或者 Custom action 不显示），用
 * `auth: false` 关闭自动 scope 检查，再用本中间件保证拿到登录用户。
 *
 * 与 `optional-auth` 的区别：本中间件**强制**已登录；optional-auth 是「有
 * token 就解析，没 token 也放行」。
 */
export default (_config: any, { strapi }: any) => {
  return async (ctx: Context, next: () => Promise<void>) => {
    if (!ctx.state?.user) {
      const authorization = ctx.request?.header?.authorization;
      if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
        const token = authorization.slice(7).trim();
        if (token) {
          try {
            const jwtService = strapi.plugin('users-permissions').service('jwt');
            const payload = await jwtService.verify(token);
            if (payload?.id) {
              const user = await strapi.db
                .query('plugin::users-permissions.user')
                .findOne({ where: { id: payload.id } });
              // A blocked user with a still-valid JWT must not pass: these
              // `auth: false` routes skip Strapi's built-in blocked-user check.
              if (user && !user.blocked) ctx.state.user = user;
            }
          } catch {
            // 无效 / 过期 token：不在此 catch 里直接抛，等下面统一 401
          }
        }
      }
    }

    if (!ctx.state?.user?.id) {
      return ctx.unauthorized('authentication required');
    }
    await next();
  };
};
