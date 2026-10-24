import type { Context } from 'koa';
/**
 * optional-auth middleware
 *
 * When a route is configured with `auth: false`, Strapi skips JWT parsing entirely
 * so ctx.state.user is always undefined. This middleware manually attempts to
 * authenticate the bearer token without rejecting anonymous requests.
 */
export default (_config: any, { strapi }: any) => {
  return async (ctx: Context, next: () => Promise<void>) => {
    // Only run when there is no authenticated user yet
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
              // Honour account state: a blocked user holding a still-valid JWT
              // must not be treated as authenticated (mirrors Strapi's built-in
              // auth, which `auth: false` routes would otherwise bypass).
              if (user && !user.blocked) {
                ctx.state.user = user;
              }
            }
          } catch {
            // Invalid / expired token — treat as anonymous, do not block
          }
        }
      }
    }
    await next();
  };
};
