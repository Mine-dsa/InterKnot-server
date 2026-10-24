/**
 * 称号/勋章（cosmetics）条件评估引擎。
 *
 * 设计目标（管理员后台超高自由度）：
 * - 每个称号/勋章可配置「触发条件」condition（JSON），支持单条件或 AND 组合；
 * - 条件满足时由懒评估/全量评估自动授予（source=auto，全程留痕）；
 * - 管理员也可无视条件手动授予（source=manual）与撤销（软删除，保留记录）；
 * - 撤销后可再次授予（新纪录），完整可追溯、可复原。
 */
import type { Core } from '@strapi/strapi';

export type CosmeticsKind = 'title' | 'medal';

export const TITLE_UID = 'api::title.title';
export const MEDAL_UID = 'api::medal.medal';
export const TITLE_GRANT_UID = 'api::title-grant.title-grant';
export const MEDAL_GRANT_UID = 'api::medal-grant.medal-grant';
const USER_UID = 'plugin::users-permissions.user';
const AUTHOR_UID = 'api::author.author';

export const cosmeticUid = (kind: CosmeticsKind) =>
  kind === 'title' ? TITLE_UID : MEDAL_UID;

export const grantUid = (kind: CosmeticsKind) =>
  kind === 'title' ? TITLE_GRANT_UID : MEDAL_GRANT_UID;

/** condition 支持的原子条件类型 */
const ATOMIC_TYPES = [
  'manual',
  'level',
  'exp',
  'article_count',
  'comment_count',
  'like_received',
  'checkin_consecutive_days',
  'denny_given',
  'exam_passed',
  'follower_count',
] as const;

export type AtomicConditionType = (typeof ATOMIC_TYPES)[number];

export type AtomicCondition =
  | { type: 'manual' }
  | { type: 'level'; min: number }
  | { type: 'exp'; min: number }
  | { type: 'article_count'; min: number }
  | { type: 'comment_count'; min: number }
  | { type: 'like_received'; min: number }
  | { type: 'checkin_consecutive_days'; min: number }
  | { type: 'denny_given'; min: number }
  | { type: 'exam_passed' }
  | { type: 'follower_count'; min: number };

export type CosmeticsCondition =
  | AtomicCondition
  | { all: AtomicCondition[] };

export interface UserCosmeticsStats {
  level: number;
  exp: number;
  articleCount: number;
  commentCount: number;
  likeReceived: number;
  checkinConsecutiveDays: number;
  dennyGiven: number;
  examPassed: boolean;
  followerCount: number;
}

const parseAtomic = (raw: unknown): AtomicCondition | null => {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== 'string' || !(ATOMIC_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  if (type === 'manual' || type === 'exam_passed') {
    return { type } as AtomicCondition;
  }
  const min = Number(obj.min);
  if (!Number.isFinite(min) || min < 0) return null;
  return { type: type as Exclude<AtomicConditionType, 'manual' | 'exam_passed'>, min } as AtomicCondition;
};

/**
 * 规范化 condition 载荷；非法输入一律回退为 manual（仅手动授予），
 * 保证脏数据不会让评估引擎抛错或意外放行。
 */
export const normalizeCondition = (raw: unknown): CosmeticsCondition => {
  if (!raw || typeof raw !== 'object') return { type: 'manual' };
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.all)) {
    const parts = obj.all.map(parseAtomic).filter((c): c is AtomicCondition => c !== null);
    if (parts.length === 0) return { type: 'manual' };
    return { all: parts };
  }

  const single = parseAtomic(obj);
  return single ?? { type: 'manual' };
};

const METRIC_LABELS: Record<string, string> = {
  level: '绳网等级',
  exp: '累计绳网信用',
  article_count: '发布帖子数',
  comment_count: '发布评论数',
  like_received: '收到的点赞数',
  checkin_consecutive_days: '连续签到天数',
  denny_given: '累计投出丁尼',
  exam_passed: '通过入站考试',
  follower_count: '粉丝数',
};

/** 生成条件的中文描述（用户面板展示解锁条件用） */
export const describeCondition = (condition: CosmeticsCondition): string => {
  const describeAtomic = (c: AtomicCondition): string => {
    if (c.type === 'manual') return '仅管理员授予';
    if (c.type === 'exam_passed') return METRIC_LABELS.exam_passed;
    return `${METRIC_LABELS[c.type] ?? c.type} ≥ ${c.min}`;
  };
  if ('all' in condition) {
    return condition.all.map(describeAtomic).join(' 且 ');
  }
  return describeAtomic(condition);
};

/**
 * 写路径（管理端）严格校验：拒绝非法 condition 载荷，避免静默降级为 manual。
 */
export const validateConditionPayload = (
  raw: unknown,
): { ok: true; value: CosmeticsCondition } | { ok: false; error: string } => {
  if (raw == null) return { ok: true, value: { type: 'manual' } };
  if (typeof raw !== 'object') return { ok: false, error: 'condition 必须是对象' };
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.all)) {
    if (obj.all.length === 0) return { ok: false, error: 'all 组合不能为空' };
    if (obj.all.length > 10) return { ok: false, error: 'all 组合最多 10 个条件' };
    const parts: AtomicCondition[] = [];
    for (const item of obj.all) {
      const atomic = parseAtomic(item);
      if (!atomic) {
        return { ok: false, error: `非法条件项: ${JSON.stringify(item)}` };
      }
      parts.push(atomic);
    }
    return { ok: true, value: { all: parts } };
  }

  const single = parseAtomic(obj);
  if (!single) {
    return { ok: false, error: `非法条件: ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: single };
};

/** 是否为纯手动条件（无任何可自动评估的原子条件） */
export const isManualCondition = (condition: CosmeticsCondition): boolean => {
  if ('all' in condition) {
    return condition.all.every((c) => c.type === 'manual');
  }
  return condition.type === 'manual';
};

export const evaluateCondition = (
  condition: CosmeticsCondition,
  stats: UserCosmeticsStats,
): boolean => {
  const evalAtomic = (c: AtomicCondition): boolean => {
    switch (c.type) {
      case 'manual':
        return false;
      case 'level':
        return stats.level >= c.min;
      case 'exp':
        return stats.exp >= c.min;
      case 'article_count':
        return stats.articleCount >= c.min;
      case 'comment_count':
        return stats.commentCount >= c.min;
      case 'like_received':
        return stats.likeReceived >= c.min;
      case 'checkin_consecutive_days':
        return stats.checkinConsecutiveDays >= c.min;
      case 'denny_given':
        return stats.dennyGiven >= c.min;
      case 'exam_passed':
        return stats.examPassed;
      case 'follower_count':
        return stats.followerCount >= c.min;
      default:
        return false;
    }
  };
  if ('all' in condition) {
    return condition.all.every(evalAtomic);
  }
  return evalAtomic(condition);
};

/** 收集单个用户的全部条件指标（并行查询） */
export const getUserStats = async (
  strapi: Core.Strapi,
  userId: number,
): Promise<UserCosmeticsStats | null> => {
  const user = await strapi.db.query(USER_UID).findOne({
    where: { id: userId },
    populate: { author: { select: ['id'] } },
  });
  if (!user) return null;

  const authorId = user.author?.id ?? null;

  const [articleCount, commentCount, articleLikeCount, commentLikeCount, followerCount] =
    await Promise.all([
      authorId
        ? strapi.db.query('api::article.article').count({
            where: { author: { id: authorId }, publishedAt: { $notNull: true } },
          })
        : Promise.resolve(0),
      authorId
        ? strapi.db.query('api::comment.comment').count({
            where: { author: { id: authorId } },
          })
        : Promise.resolve(0),
      authorId
        ? strapi.db.query('api::like.like').count({
            where: { article: { author: { id: authorId } } },
          })
        : Promise.resolve(0),
      authorId
        ? strapi.db.query('api::like.like').count({
            where: { comment: { author: { id: authorId } } },
          })
        : Promise.resolve(0),
      authorId
        ? strapi.db.query('api::follow.follow').count({
            where: { following: { id: authorId } },
          })
        : Promise.resolve(0),
    ]);

  return {
    level: user.level ?? 0,
    exp: user.exp ?? 0,
    articleCount,
    commentCount,
    likeReceived: articleLikeCount + commentLikeCount,
    checkinConsecutiveDays: user.consecutiveCheckInDays ?? 0,
    dennyGiven: user.denny_given ?? 0,
    examPassed: user.examPassed === true,
    followerCount,
  };
};

/** 该用户对指定 cosmetic 是否存在生效（未撤销）的授予记录 */
export const hasActiveGrant = async (
  strapi: Core.Strapi,
  kind: CosmeticsKind,
  userId: number,
  cosmeticId: number,
): Promise<boolean> => {
  const relKey = kind === 'title' ? 'title' : 'medal';
  const existing = await strapi.db.query(grantUid(kind)).findOne({
    where: {
      user: { id: userId },
      [relKey]: { id: cosmeticId },
      revokedAt: { $null: true },
    },
    select: ['id'],
  });
  return !!existing;
};

/**
 * 手动授予（管理员）。已存在生效记录时直接返回该记录（幂等）。
 * equipAfterGrant: 授予后是否自动为用户装备（默认 false，由用户自行选择）。
 */
export const grantCosmetic = async (
  strapi: Core.Strapi,
  kind: CosmeticsKind,
  params: {
    userId: number;
    cosmeticId: number;
    source: 'manual' | 'auto';
    grantedByUserId?: number | null;
    reason?: string | null;
  },
) => {
  const relKey = kind === 'title' ? 'title' : 'medal';
  const existing = await strapi.db.query(grantUid(kind)).findOne({
    where: {
      user: { id: params.userId },
      [relKey]: { id: params.cosmeticId },
      revokedAt: { $null: true },
    },
    select: ['id', 'documentId'],
  });
  if (existing) {
    return { created: false, grant: existing };
  }

  const grant = await strapi.db.query(grantUid(kind)).create({
    data: {
      user: params.userId,
      [relKey]: params.cosmeticId,
      source: params.source,
      grantedBy: params.grantedByUserId ?? null,
      reason: params.reason?.substring(0, 200) || null,
    },
  });
  return { created: true, grant };
};

/**
 * 撤销授予（软删除）。若用户正装备该 cosmetic，同步卸下。
 * 返回被撤销的记录；不存在生效记录时返回 null。
 */
export const revokeCosmetic = async (
  strapi: Core.Strapi,
  kind: CosmeticsKind,
  params: {
    userId: number;
    cosmeticId: number;
    revokedByUserId?: number | null;
    reason?: string | null;
  },
) => {
  const relKey = kind === 'title' ? 'title' : 'medal';
  const now = new Date();
  const active = await strapi.db.query(grantUid(kind)).findOne({
    where: {
      user: { id: params.userId },
      [relKey]: { id: params.cosmeticId },
      revokedAt: { $null: true },
    },
    select: ['id'],
  });
  if (!active) return null;

  const updated = await strapi.db.query(grantUid(kind)).update({
    where: { id: active.id },
    data: {
      revokedAt: now,
      revokedBy: params.revokedByUserId ?? null,
      revokeReason: params.reason?.substring(0, 200) || null,
    },
  });

  // 卸下装备：仅当用户当前装备的正是被撤销的这件
  const equipField = kind === 'title' ? 'equippedTitle' : 'equippedMedal';
  const user = await strapi.db.query(USER_UID).findOne({
    where: { id: params.userId },
    populate: { [equipField]: { select: ['id'] } },
  });
  if (user?.[equipField]?.id === params.cosmeticId) {
    await strapi.db.query(USER_UID).update({
      where: { id: params.userId },
      data: { [equipField]: null },
    });
  }

  return updated;
};

/**
 * 懒评估：为指定用户评估所有 enabled 且非 manual 的 cosmetics，
 * 条件满足且尚无生效授予时自动授予（source=auto，留痕）。
 * 返回本次新授予的数量。
 */
export const evaluateAndGrantAuto = async (
  strapi: Core.Strapi,
  userId: number,
): Promise<number> => {
  const stats = await getUserStats(strapi, userId);
  if (!stats) return 0;

  let granted = 0;
  for (const kind of ['title', 'medal'] as CosmeticsKind[]) {
    const cosmetics = await strapi.db.query(cosmeticUid(kind)).findMany({
      where: { enabled: true },
      select: ['id', 'condition'],
      limit: 500,
    });
    for (const item of cosmetics || []) {
      const condition = normalizeCondition(item?.condition);
      if (isManualCondition(condition)) continue;
      if (!evaluateCondition(condition, stats)) continue;

      const active = await hasActiveGrant(strapi, kind, userId, item.id);
      if (active) continue;

      const result = await grantCosmetic(strapi, kind, {
        userId,
        cosmeticId: item.id,
        source: 'auto',
        reason: '条件自动达成',
      });
      if (result.created) granted += 1;
    }
  }
  return granted;
};
