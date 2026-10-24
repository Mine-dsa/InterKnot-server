import type { Core } from '@strapi/strapi';
import type { Context } from 'koa';

const USER_UID = 'plugin::users-permissions.user';

export default (plugin: any) => {
  plugin.controllers.auth.register = async (ctx: Context) => {
    const body = (ctx.request?.body || {}) as Record<string, unknown>;
    const username = body.username;
    const password = body.password;
    const email = body.email;

    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      ctx.status = 400;
      ctx.body = { error: { code: 'INVALID_USERNAME', message: '用户名至少需要 2 个字符' } };
      return;
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      ctx.status = 400;
      ctx.body = { error: { code: 'INVALID_PASSWORD', message: '密码长度不能少于 6 位' } };
      return;
    }

    const normalizedUsername = username.trim();

    const settings = await strapi
      .store({ type: 'plugin', name: 'users-permissions' })
      .get({ key: 'advanced' }) as Record<string, unknown> | null;

    if (settings && !settings.allow_register) {
      ctx.status = 403;
      ctx.body = { error: { code: 'REGISTER_DISABLED', message: '当前不允许注册' } };
      return;
    }

    const userEmail = (typeof email === 'string' && email.includes('@'))
      ? email.trim().toLowerCase()
      : `${normalizedUsername}@local.user`;

    const existing = await strapi.db.query(USER_UID).findOne({
      where: { $or: [{ username: normalizedUsername }, { email: userEmail }] },
      select: ['id'],
    });

    if (existing) {
      ctx.status = 409;
      ctx.body = { error: { code: 'USERNAME_TAKEN', message: '该用户名已被使用' } };
      return;
    }

    const role = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: 'authenticated' },
    });

    if (!role) {
      ctx.status = 500;
      ctx.body = { error: { code: 'ROLE_NOT_FOUND', message: '用户角色配置错误' } };
      return;
    }

    const user = await strapi.plugin('users-permissions').service('user').add({
      username: normalizedUsername,
      email: userEmail,
      password: password as string,
      provider: 'local',
      role: role.id,
      confirmed: true,
      level: 0,
      examPassed: false,
      denny: 100,
    });

    const jwt = strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });
    const sanitizedUser = await strapi
      .contentAPI.sanitize.output(user, strapi.getModel(USER_UID), { auth: {} });

    ctx.status = 201;
    ctx.body = { jwt, user: sanitizedUser };
  };

  return plugin;
};
