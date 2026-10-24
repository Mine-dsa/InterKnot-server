import crypto from 'node:crypto';

/**
 * 匿名展示前缀，所有匿名作者的展示名都形如 `${ANONYMOUS_NAME_PREFIX}#XXXX`。
 */
export const ANONYMOUS_NAME_PREFIX = '绳网用户';

/**
 * 生成一条记录的匿名 seed（仅服务端持有，不应回传给客户端）。
 * 用于派生稳定的匿名展示名，使同一条记录在多次请求/不同观察者下显示一致，
 * 但不同记录之间不可串联。
 */
export const generateAnonymousSeed = (): string =>
  crypto.randomBytes(16).toString('hex');

const hashSeedToHex = (seed: string): string =>
  crypto.createHash('sha256').update(seed, 'utf8').digest('hex');

/**
 * 根据 seed 派生稳定的匿名展示名，例如 `绳网用户#7F3A`。
 * 当 seed 缺失时回退到固定占位，避免崩溃。
 */
export const buildAnonymousName = (seed: string | null | undefined): string => {
  const safeSeed =
    typeof seed === 'string' && seed.length > 0 ? seed : 'anonymous-fallback';
  const code = hashSeedToHex(safeSeed).slice(0, 4).toUpperCase();
  return `${ANONYMOUS_NAME_PREFIX}#${code}`;
};

export interface AnonymousAuthorDisplay {
  documentId: null;
  name: string;
  avatar: string | null;
  level: null;
}

/**
 * 构造匿名作者展示对象：documentId/level 一律置空，防止跳转到真实用户主页。
 * 若用户装备了系统头像（equippedAvatar），则保留该头像 URL；
 * 自定义上传头像不会出现在此处，避免通过头像反查真实身份。
 */
export const buildAnonymousAuthor = (
  seed: string | null | undefined,
  equippedAvatarUrl?: string | null,
): AnonymousAuthorDisplay => ({
  documentId: null,
  name: buildAnonymousName(seed),
  avatar: equippedAvatarUrl ?? null,
  level: null,
});

/**
 * 判断当前观察者是否需要看到匿名占位。
 * 匿名帖对所有人（包括作者本人）一律匿名化。
 */
export const shouldAnonymize = (
  isAnonymous: unknown,
  _ownerUserId?: number | null,
  _viewerUserId?: number | null,
): boolean => {
  return !!isAnonymous;
};
