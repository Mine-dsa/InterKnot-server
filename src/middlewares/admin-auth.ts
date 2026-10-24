import type { Context } from 'koa';

export default (_config: any, { strapi }: any) => {
  return async (ctx: Context, next: any) => {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('需要登录');

    if (user.blocked) return ctx.unauthorized('账号已被封禁');

    const freshUser = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { id: user.id },
        select: ['id', 'isAdmin', 'blocked'],
      });

    if (!freshUser) return ctx.unauthorized('用户不存在');
    if (freshUser.blocked) return ctx.unauthorized('账号已被封禁');
    if (!freshUser.isAdmin) return ctx.forbidden('需要管理员权限');

    ctx.state.user = { ...user, isAdmin: freshUser.isAdmin, blocked: freshUser.blocked };

    return next();
  };
};
