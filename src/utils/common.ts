import type { Context } from 'koa';
import type { Core } from '@strapi/strapi';
export const parsePagination = (
  startRaw: unknown,
  limitRaw: unknown,
  maxLimit = 50,
  defaultLimit = 20,
) => {
  const start = Number.isNaN(Number.parseInt(String(startRaw), 10))
    ? 0
    : Number.parseInt(String(startRaw), 10);
  const limit = Number.isNaN(Number.parseInt(String(limitRaw), 10))
    ? defaultLimit
    : Number.parseInt(String(limitRaw), 10);

  return {
    start: start < 0 ? 0 : start,
    limit: limit < 1 ? defaultLimit : Math.min(limit, maxLimit),
  };
};

export const withSmallWebp = <T extends { url?: unknown }>(
  media: T | null | undefined,
): T | null | undefined => {
  if (!media) return media;
  const url = typeof media.url === 'string' ? media.url : '';
  if (!url || url.endsWith('-small.webp')) return media;
  return { ...media, url: `${url}-small.webp` } as T;
};

/**
 * 从 unknown 的 catch 变量里安全取出错误消息文本。
 * 与此前的 `err?.message` 行为一致：仅当存在字符串 message 时返回它，否则返回 ''。
 */
export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
};

export const formatLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Batch-resolve equipped avatar image objects for a list of user IDs.
 * Returns Map<userId, imageMediaObject>.
 */
export const batchResolveEquippedAvatars = async (
  strapi: Core.Strapi,
  userIds: number[]
): Promise<Map<number, any>> => {
  if (!userIds.length) return new Map();

  const users = await strapi.db.query('plugin::users-permissions.user').findMany({
    where: { id: { $in: userIds } },
    select: ['id'],
    populate: {
      equippedAvatar: {
        populate: {
          image: { select: ['url', 'width', 'height'] },
        },
      },
    },
  });

  const map = new Map<number, any>();
  for (const user of users || []) {
    const image = user?.equippedAvatar?.image;
    if (image?.url) {
      map.set(user.id, image);
    }
  }
  return map;
};

export const extractRelationId = (value: any): number | null => {
  if (!value) return null;
  if (typeof value === 'number') return value;
  if (typeof value?.id === 'number') return value.id;

  const connect = Array.isArray(value?.connect) ? value.connect[0] : null;
  if (typeof connect === 'number') return connect;
  if (typeof connect?.id === 'number') return connect.id;

  return null;
};

/**
 * Resolve the client IP without blindly trusting the leftmost (client-controlled,
 * therefore spoofable) `X-Forwarded-For` value.
 *
 * Behind a reverse proxy the trustworthy entries are the *rightmost* ones, which
 * are appended by your own infrastructure. `TRUSTED_PROXY_HOPS` declares how many
 * trusted proxies sit in front of the app (nginx = 1, CDN + nginx = 2); we read
 * the entry that many hops from the right. Defaults to 1 because the server runs
 * with `proxy: true`. Set it to 0 to fall back to the raw socket peer address
 * (useful when there is no proxy and the header must not be trusted at all).
 */
export const getClientIp = (ctx: Context): string => {
  const socketIp =
    ctx?.request?.socket?.remoteAddress ||
    ctx?.req?.socket?.remoteAddress ||
    '0.0.0.0';

  const hopsRaw = Number.parseInt(process.env.TRUSTED_PROXY_HOPS || '', 10);
  const hops = Number.isFinite(hopsRaw) && hopsRaw >= 0 ? hopsRaw : 1;
  if (hops <= 0) return socketIp;

  const header = ctx?.request?.headers?.['x-forwarded-for'];
  const xff = typeof header === 'string'
    ? header
    : Array.isArray(header)
      ? header.join(',')
      : '';
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return socketIp;

  const idx = parts.length - hops;
  return parts[idx >= 0 ? idx : 0] || socketIp;
};
