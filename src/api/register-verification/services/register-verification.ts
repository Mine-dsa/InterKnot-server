import type { Core } from '@strapi/strapi';
import crypto from 'crypto';

const USER_UID = 'plugin::users-permissions.user';
const VERIFICATION_UID = 'api::register-verification.register-verification';
const CODE_TTL_SECONDS = getPositiveIntegerEnv('REGISTER_CODE_TTL_SECONDS', 10 * 60);
const SEND_COOLDOWN_SECONDS = getPositiveIntegerEnv('REGISTER_CODE_COOLDOWN_SECONDS', 60);
const MAX_VERIFY_ATTEMPTS = getPositiveIntegerEnv('REGISTER_CODE_MAX_ATTEMPTS', 5);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FlowError = Error & {
  status?: number;
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
};

function getPositiveIntegerEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createFlowError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): FlowError {
  const error = new Error(message) as FlowError;
  error.status = status;
  error.statusCode = status;
  error.code = code;
  error.details = details;
  return error;
}

function normalizeEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validateEmail(value: unknown) {
  const email = normalizeEmail(value);
  if (!email || email.length < 6 || !EMAIL_PATTERN.test(email)) {
    throw createFlowError(400, 'INVALID_EMAIL', '邮箱格式不正确');
  }
  return email;
}

function validatePassword(value: unknown) {
  if (typeof value !== 'string' || value.length < 6) {
    throw createFlowError(400, 'INVALID_PASSWORD', '密码长度不能少于 6 位');
  }
  return value;
}

function validateCode(value: unknown) {
  const code = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!/^\d{6}$/.test(code)) {
    throw createFlowError(400, 'INVALID_VERIFICATION_CODE', '验证码必须是 6 位数字');
  }
  return code;
}

function generateCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function getHashSecret(strapi: Core.Strapi) {
  const configuredSecret = process.env.REGISTER_CODE_SECRET || process.env.JWT_SECRET;
  if (configuredSecret) return configuredSecret;

  const appKeys = strapi.config.get('server.app.keys');
  if (Array.isArray(appKeys) && appKeys.length > 0) return appKeys.join(':');
  if (typeof appKeys === 'string' && appKeys) return appKeys;

  throw createFlowError(500, 'REGISTER_CODE_SECRET_MISSING', '注册验证码密钥未配置');
}

function hashCode(strapi: Core.Strapi, email: string, code: string) {
  return crypto
    .createHmac('sha256', getHashSecret(strapi))
    .update(`${email}:${code}`)
    .digest('hex');
}

function getVerificationQuery(strapi: Core.Strapi) {
  return strapi.db.query(VERIFICATION_UID);
}

type AdvancedSettings = {
  unique_email?: boolean;
  allow_register?: boolean;
  email_confirmation?: boolean;
  default_role?: string;
  [k: string]: unknown;
};

async function getAdvancedSettings(strapi: Core.Strapi): Promise<AdvancedSettings> {
  const pluginStore = await strapi.store({ type: 'plugin', name: 'users-permissions' });
  const settings = (await pluginStore.get({ key: 'advanced' })) as AdvancedSettings | null;
  return (
    settings || {
      unique_email: true,
      allow_register: true,
      email_confirmation: false,
      default_role: 'authenticated',
    }
  );
}

async function getDefaultRole(strapi: Core.Strapi, settings: AdvancedSettings) {
  const role = await strapi.db
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: settings.default_role } });

  if (!role) {
    throw createFlowError(500, 'DEFAULT_ROLE_NOT_FOUND', '默认用户角色不存在');
  }

  return role;
}

async function assertRegisterEnabled(strapi: Core.Strapi) {
  const settings = await getAdvancedSettings(strapi);
  if (!settings.allow_register) {
    throw createFlowError(403, 'REGISTER_DISABLED', '当前不允许注册');
  }
  return settings;
}

async function findConflictingUser(strapi: Core.Strapi, email: string, username?: string) {
  const filters = [{ email }, { username: email }];

  if (username) {
    filters.push({ username }, { email: username });
  }

  return strapi.db.query(USER_UID).findOne({
    where: {
      $or: filters,
    },
    select: ['id'],
  });
}

async function assertEmailAvailable(strapi: Core.Strapi, email: string, username?: string) {
  const conflictingUser = await findConflictingUser(strapi, email, username);
  if (conflictingUser) {
    throw createFlowError(409, 'EMAIL_ALREADY_TAKEN', '该邮箱已注册');
  }
}

function generateRandomSuffix(length = 4) {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let suffix = '';

  for (let i = 0; i < length; i += 1) {
    suffix += alphabet[crypto.randomInt(0, alphabet.length)];
  }

  return suffix;
}

async function generateUniqueUsername(strapi: Core.Strapi) {
  const base = '绳网用户';

  for (let i = 0; i < 20; i += 1) {
    const candidate = `${base}${generateRandomSuffix()}`;
    const existing = await strapi.db.query(USER_UID).count({
      where: {
        $or: [{ username: candidate }, { email: candidate }],
      },
    });

    if (!existing) return candidate;
  }

  return `${base}${generateRandomSuffix(8)}`;
}

function buildCodeHtml(code: string) {
  const minutes = Math.floor(CODE_TTL_SECONDS / 60);
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>验证码 - INTER-KNOT</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
          <tr>
            <td style="background:rgba(255,255,255,0.12);padding:3px;border-radius:16px 0 16px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111111;border-radius:14px 0 14px 14px;overflow:hidden;">
                <tr>
                  <td style="background-color:#161616;padding:20px 28px;border-bottom:1px solid #222222;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td>
                          <img src="http://image.tiwat.cn/zzzicon_200x200.png" alt="INTER-KNOT" width="36" height="36" style="display:block;border:0;outline:none;" />
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 28px 20px;">
                    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#e8e8e8;">注册验证码</p>
                    <p style="margin:0 0 28px;font-size:14px;color:#9a9a9a;line-height:1.6;">请使用以下验证码完成账号注册</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" style="padding:24px 0;">
                          <div style="display:inline-block;background-color:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #d7ff00;border-radius:0 8px 8px 0;padding:18px 40px;font-size:36px;font-weight:800;letter-spacing:12px;color:#d7ff00;font-family:'Consolas','Monaco','Courier New',monospace;">${code}</div>
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" style="padding:8px 0 24px;">
                          <p style="margin:0;font-size:13px;color:#9a9a9a;">验证码有效期 <span style="color:#e8e8e8;font-weight:600;">${minutes} 分钟</span>，请尽快使用</p>
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="height:1px;background-color:#222222;font-size:0;line-height:0;">&nbsp;</td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:20px 0 0;">
                          <p style="margin:0;font-size:12px;color:#666666;line-height:1.8;">如果你没有请求此验证码，请忽略此邮件。<br/>请勿将验证码分享给任何人。</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 0 0;">
              <p style="margin:0;font-size:12px;color:#444444;line-height:1.6;">&copy; ${year} INTER-KNOT &middot; 绳网</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildResetCodeHtml(code: string) {
  const minutes = Math.floor(CODE_TTL_SECONDS / 60);
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="zh-CN" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>重置密码 - INTER-KNOT</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#0a0a0a;font-family:'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;">
          <tr>
            <td style="background:rgba(255,255,255,0.12);padding:3px;border-radius:16px 0 16px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#111111;border-radius:14px 0 14px 14px;overflow:hidden;">
                <tr>
                  <td style="background-color:#161616;padding:20px 28px;border-bottom:1px solid #222222;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td>
                          <img src="http://image.tiwat.cn/zzzicon_200x200.png" alt="INTER-KNOT" width="36" height="36" style="display:block;border:0;outline:none;" />
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:36px 28px 20px;">
                    <p style="margin:0 0 6px;font-size:18px;font-weight:700;color:#e8e8e8;">重置密码</p>
                    <p style="margin:0 0 28px;font-size:14px;color:#9a9a9a;line-height:1.6;">请使用以下验证码完成密码重置</p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" style="padding:24px 0;">
                          <div style="display:inline-block;background-color:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #d7ff00;border-radius:0 8px 8px 0;padding:18px 40px;font-size:36px;font-weight:800;letter-spacing:12px;color:#d7ff00;font-family:'Consolas','Monaco','Courier New',monospace;">${code}</div>
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" style="padding:8px 0 24px;">
                          <p style="margin:0;font-size:13px;color:#9a9a9a;">验证码有效期 <span style="color:#e8e8e8;font-weight:600;">${minutes} 分钟</span>，请尽快使用</p>
                        </td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="height:1px;background-color:#222222;font-size:0;line-height:0;">&nbsp;</td>
                      </tr>
                    </table>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="padding:20px 0 0;">
                          <p style="margin:0;font-size:12px;color:#666666;line-height:1.8;">如果你没有请求重置密码，请忽略此邮件，你的密码不会被更改。<br/>请勿将验证码分享给任何人。</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 0 0;">
              <p style="margin:0;font-size:12px;color:#444444;line-height:1.6;">&copy; ${year} INTER-KNOT &middot; 绳网</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendEmailCode(strapi: Core.Strapi, email: string, code: string) {
  const minutes = Math.floor(CODE_TTL_SECONDS / 60);
  await strapi.plugin('email').service('email').send({
    to: email,
    subject: '注册验证码 - INTER-KNOT',
    text: `您的注册验证码是 ${code}，${minutes} 分钟内有效。请勿将验证码分享给任何人。`,
    html: buildCodeHtml(code),
  });
}

async function sendResetEmailCode(strapi: Core.Strapi, email: string, code: string) {
  const minutes = Math.floor(CODE_TTL_SECONDS / 60);
  await strapi.plugin('email').service('email').send({
    to: email,
    subject: '重置密码 - INTER-KNOT',
    text: `您的验证码是 ${code}，${minutes} 分钟内有效。如果你没有请求重置密码，请忽略此邮件。`,
    html: buildResetCodeHtml(code),
  });
}

export default ({ strapi }: any) => ({
  async sendRegisterCode(body: any, requestIp?: string) {
    const email = validateEmail(body?.email);
    await assertRegisterEnabled(strapi);

    // 防邮箱枚举（与 sendResetCode 同范式）：邮箱已注册时不暴露差异，
    // 返回与成功完全同形的响应（不创建记录、不发送邮件）。
    const conflictingUser = await findConflictingUser(strapi, email);
    if (conflictingUser) {
      strapi.log.warn(
        `[register-verification] register code requested for an occupied email, silently skipped (ip=${requestIp || 'unknown'})`
      );
      return {
        email,
        expiresIn: CODE_TTL_SECONDS,
        cooldown: SEND_COOLDOWN_SECONDS,
      };
    }

    const now = new Date();
    const recent = await getVerificationQuery(strapi).findOne({
      where: {
        email,
        purpose: 'register',
        consumedAt: null,
        sentAt: {
          $gte: new Date(now.getTime() - SEND_COOLDOWN_SECONDS * 1000),
        },
      },
      orderBy: { sentAt: 'desc' },
      select: ['id', 'sentAt'],
    });

    if (recent?.sentAt) {
      const sentAt = new Date(recent.sentAt).getTime();
      const retryAfter = Math.max(
        1,
        SEND_COOLDOWN_SECONDS - Math.floor((now.getTime() - sentAt) / 1000)
      );
      throw createFlowError(429, 'REGISTER_CODE_COOLDOWN', '验证码发送过于频繁，请稍后再试', {
        retryAfter,
      });
    }

    const code = generateCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000);

    await getVerificationQuery(strapi).updateMany({
      where: {
        email,
        purpose: 'register',
        consumedAt: null,
      },
      data: {
        consumedAt: now,
      },
    });

    const record = await getVerificationQuery(strapi).create({
      data: {
        email,
        purpose: 'register',
        codeHash: hashCode(strapi, email, code),
        sentAt: now,
        expiresAt,
        attempts: 0,
        requestIp: requestIp || null,
      },
    });

    try {
      await sendEmailCode(strapi, email, code);
    } catch (err) {
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      strapi.log.error(err);
      throw createFlowError(500, 'REGISTER_CODE_EMAIL_FAILED', '验证码邮件发送失败');
    }

    return {
      email,
      expiresIn: CODE_TTL_SECONDS,
      cooldown: SEND_COOLDOWN_SECONDS,
    };
  },

  async registerWithCode(body: any) {
    const email = validateEmail(body?.email);
    const code = validateCode(body?.code);
    const password = validatePassword(body?.password);
    const settings = await assertRegisterEnabled(strapi);
    const role = await getDefaultRole(strapi, settings);

    await assertEmailAvailable(strapi, email);

    const now = new Date();
    const record = await getVerificationQuery(strapi).findOne({
      where: {
        email,
        purpose: 'register',
        consumedAt: null,
      },
      orderBy: { sentAt: 'desc' },
    });

    if (!record) {
      throw createFlowError(400, 'REGISTER_CODE_NOT_FOUND', '验证码不存在或已失效');
    }

    if (!record.expiresAt || new Date(record.expiresAt).getTime() <= now.getTime()) {
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: { consumedAt: now },
      });
      throw createFlowError(400, 'REGISTER_CODE_EXPIRED', '验证码已过期');
    }

    if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: { consumedAt: now },
      });
      throw createFlowError(429, 'REGISTER_CODE_TOO_MANY_ATTEMPTS', '验证码错误次数过多，请重新获取');
    }

    if (record.codeHash !== hashCode(strapi, email, code)) {
      const attempts = (record.attempts || 0) + 1;
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: {
          attempts,
          consumedAt: attempts >= MAX_VERIFY_ATTEMPTS ? now : null,
        },
      });
      throw createFlowError(400, 'REGISTER_CODE_INVALID', '验证码错误', {
        attemptsRemaining: Math.max(0, MAX_VERIFY_ATTEMPTS - attempts),
      });
    }

    const username = await generateUniqueUsername(strapi);
    await assertEmailAvailable(strapi, email, username);

    await getVerificationQuery(strapi).update({
      where: { id: record.id },
      data: { consumedAt: now },
    });

    const user = await strapi.plugin('users-permissions').service('user').add({
      username,
      email,
      password,
      provider: 'local',
      role: role.id,
      confirmed: true,
      // 未通过入站考试前等级为 0，通过后升至 1 级
      level: 0,
      examPassed: false,
    });

    return user;
  },

  async sendResetCode(body: any, requestIp?: string) {
    const email = validateEmail(body?.email);

    // 安全：无论邮箱是否存在都返回相同响应结构，防止枚举
    const existingUser = await strapi.db.query(USER_UID).findOne({
      where: { $or: [{ email }, { username: email }] },
      select: ['id', 'email'],
    });

    if (!existingUser) {
      // 不暴露邮箱是否注册；静默返回
      return { email, expiresIn: CODE_TTL_SECONDS, cooldown: SEND_COOLDOWN_SECONDS };
    }

    const targetEmail = existingUser.email as string;
    const now = new Date();

    const recent = await getVerificationQuery(strapi).findOne({
      where: {
        email: targetEmail,
        purpose: 'reset-password',
        consumedAt: null,
        sentAt: { $gte: new Date(now.getTime() - SEND_COOLDOWN_SECONDS * 1000) },
      },
      orderBy: { sentAt: 'desc' },
      select: ['id', 'sentAt'],
    });

    if (recent?.sentAt) {
      const sentAt = new Date(recent.sentAt).getTime();
      const retryAfter = Math.max(
        1,
        SEND_COOLDOWN_SECONDS - Math.floor((now.getTime() - sentAt) / 1000)
      );
      throw createFlowError(429, 'RESET_CODE_COOLDOWN', '验证码发送过于频繁，请稍后再试', {
        retryAfter,
      });
    }

    const code = generateCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_SECONDS * 1000);

    // 废弃该邮箱之前未消费的重置验证码
    await getVerificationQuery(strapi).updateMany({
      where: { email: targetEmail, purpose: 'reset-password', consumedAt: null },
      data: { consumedAt: now },
    });

    const record = await getVerificationQuery(strapi).create({
      data: {
        email: targetEmail,
        purpose: 'reset-password',
        codeHash: hashCode(strapi, targetEmail, code),
        sentAt: now,
        expiresAt,
        attempts: 0,
        requestIp: requestIp || null,
      },
    });

    try {
      await sendResetEmailCode(strapi, targetEmail, code);
    } catch (err) {
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
      strapi.log.error(err);
      throw createFlowError(500, 'RESET_CODE_EMAIL_FAILED', '验证码邮件发送失败');
    }

    return { email: targetEmail, expiresIn: CODE_TTL_SECONDS, cooldown: SEND_COOLDOWN_SECONDS };
  },

  async resetPassword(body: any) {
    const email = validateEmail(body?.email);
    const code = validateCode(body?.code);
    const password = validatePassword(body?.password);

    const existingUser = await strapi.db.query(USER_UID).findOne({
      where: { $or: [{ email }, { username: email }] },
      select: ['id', 'email'],
    });

    if (!existingUser) {
      throw createFlowError(400, 'RESET_USER_NOT_FOUND', '验证码无效或已过期');
    }

    const targetEmail = existingUser.email as string;
    const now = new Date();

    const record = await getVerificationQuery(strapi).findOne({
      where: {
        email: targetEmail,
        purpose: 'reset-password',
        consumedAt: null,
      },
      orderBy: { sentAt: 'desc' },
    });

    if (!record) {
      throw createFlowError(400, 'RESET_CODE_NOT_FOUND', '验证码不存在或已失效');
    }

    if (!record.expiresAt || new Date(record.expiresAt).getTime() <= now.getTime()) {
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: { consumedAt: now },
      });
      throw createFlowError(400, 'RESET_CODE_EXPIRED', '验证码已过期');
    }

    if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: { consumedAt: now },
      });
      throw createFlowError(429, 'RESET_CODE_TOO_MANY_ATTEMPTS', '验证码错误次数过多，请重新获取');
    }

    if (record.codeHash !== hashCode(strapi, targetEmail, code)) {
      const attempts = (record.attempts || 0) + 1;
      await getVerificationQuery(strapi).update({
        where: { id: record.id },
        data: {
          attempts,
          consumedAt: attempts >= MAX_VERIFY_ATTEMPTS ? now : null,
        },
      });
      throw createFlowError(400, 'RESET_CODE_INVALID', '验证码错误', {
        attemptsRemaining: Math.max(0, MAX_VERIFY_ATTEMPTS - attempts),
      });
    }

    // 验证码正确，消费并更新密码
    await getVerificationQuery(strapi).update({
      where: { id: record.id },
      data: { consumedAt: now },
    });

    await strapi.plugin('users-permissions').service('user').edit(existingUser.id, { password });

    return { success: true };
  },
});
