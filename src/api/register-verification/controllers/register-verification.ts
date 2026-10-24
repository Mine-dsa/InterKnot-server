import type { Context } from 'koa';
import crypto from 'crypto';
import { getClientIp } from '../../../utils/common';

const sanitizeUser = (user: any, ctx: Context) => {
  const { auth } = ctx.state || {};
  const userSchema = strapi.getModel('plugin::users-permissions.user');
  return strapi.contentAPI.sanitize.output(user, userSchema, { auth });
};

const extractDeviceId = (body: any) => {
  const deviceId = body?.deviceId;
  return typeof deviceId === 'string' && deviceId.length > 0 ? deviceId : undefined;
};

const getRequestIp = (ctx: Context) => getClientIp(ctx) || undefined;

const createAuthResponse = async (user: any, sanitizedUser: any, body: any) => {
  const mode = String(strapi.config.get('plugin::users-permissions.jwtManagement', 'legacy-support'));

  if (mode === 'refresh') {
    const deviceId = extractDeviceId(body) || crypto.randomUUID();
    const refresh = await strapi
      .sessionManager('users-permissions')
      .generateRefreshToken(String(user.id), deviceId, { type: 'refresh' });
    const access = await strapi
      .sessionManager('users-permissions')
      .generateAccessToken(refresh.token);

    if ('error' in access) {
      const error = new Error('Invalid credentials') as Error & {
        status?: number;
        code?: string;
      };
      error.status = 400;
      error.code = 'INVALID_CREDENTIALS';
      throw error;
    }

    return { jwt: access.token, refreshToken: refresh.token, user: sanitizedUser };
  }

  const jwt = strapi.plugin('users-permissions').service('jwt').issue({ id: user.id });
  return { jwt, user: sanitizedUser };
};

export default {
  async sendRegisterCode(ctx: Context) {
    const result = await strapi
      .service('api::register-verification.register-verification')
      .sendRegisterCode(ctx.request?.body, getRequestIp(ctx));

    ctx.send({
      email: result.email,
      sent: true,
      expiresIn: result.expiresIn,
      cooldown: result.cooldown,
    });
  },

  async registerWithCode(ctx: Context) {
    const user = await strapi
      .service('api::register-verification.register-verification')
      .registerWithCode(ctx.request?.body);
    const sanitizedUser = await sanitizeUser(user, ctx);
    const body = await createAuthResponse(user, sanitizedUser, ctx.request?.body);

    ctx.status = 201;
    ctx.send(body);
  },

  async sendResetCode(ctx: Context) {
    const result = await strapi
      .service('api::register-verification.register-verification')
      .sendResetCode(ctx.request?.body, getRequestIp(ctx));

    ctx.send({
      email: result.email,
      sent: true,
      expiresIn: result.expiresIn,
      cooldown: result.cooldown,
    });
  },

  async resetPasswordWithCode(ctx: Context) {
    const result = await strapi
      .service('api::register-verification.register-verification')
      .resetPassword(ctx.request?.body);

    ctx.send(result);
  },

  async renewToken(ctx: Context) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized();

    // Verify the user still exists and is not blocked
    const freshUser = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { id: user.id },
        select: ['id', 'blocked'],
      });

    if (!freshUser) return ctx.unauthorized('User not found');
    if (freshUser.blocked) return ctx.unauthorized('Account is blocked');

    const jwtService = strapi.plugin('users-permissions').service('jwt');
    const newToken = jwtService.issue({ id: freshUser.id });

    ctx.send({ jwt: newToken });
  },

  async simpleRegister(ctx: Context) {
    const body = (ctx.request?.body || {}) as Record<string, unknown>;
    const username = body.username;
    const password = body.password;

    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      return ctx.badRequest('用户名至少需要 2 个字符');
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return ctx.badRequest('密码长度不能少于 6 位');
    }

    const normalizedUsername = username.trim();

    const settings = await strapi
      .store({ type: 'plugin', name: 'users-permissions' })
      .get({ key: 'advanced' }) as Record<string, unknown> | null;

    if (settings && !settings.allow_register) {
      return ctx.forbidden('当前不允许注册');
    }

    const userEmail = `${normalizedUsername}@local.user`;

    const existing = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: {
        $or: [
          { username: normalizedUsername },
          { email: userEmail },
        ],
      },
      select: ['id'],
    });

    if (existing) {
      return ctx.conflict('该用户名已被使用');
    }

    const role = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: 'authenticated' },
    });

    if (!role) {
      return ctx.internalServerError('用户角色配置错误');
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

    const sanitizedUser = await sanitizeUser(user, ctx);
    const authResponse = await createAuthResponse(user, sanitizedUser, body);

    ctx.status = 201;
    ctx.send(authResponse);
  },
};
