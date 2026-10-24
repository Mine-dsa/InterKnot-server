import type { Core } from '@strapi/strapi';
/**
 * DM 业务公用工具：
 * - 成员关系判断（是否在会话内、是否管理员）
 * - findOrCreateDirect：私聊冷启动幂等保证
 * - 列表 / 详情用的统一序列化（避免 controller 之间漂移）
 * - Redis 缓存键约定与 invalidate
 *
 * 设计原则：
 * - 这里所有函数对 Strapi 的依赖统一通过形参 `strapi: Core.Strapi` 传入，方便单测与
 *   未来抽离到 service。
 * - 抛 error 时用普通 Error；controller 在外层把它翻译成 ctx.badRequest /
 *   ctx.forbidden 等正确语义。
 */
import { getRedis } from '../../../utils/redis';

/* ─────────────────────── 缓存键 ─────────────────────── */

/** 用户 X 的会话列表缓存（短 TTL，写入路径 invalidate） */
export const dmConvListKey = (userId: number) => `dm:conv-list:${userId}`;
/** 单会话元信息缓存 */
export const dmConvInfoKey = (conversationId: number) => `dm:conv:${conversationId}`;
/** 限流键：单用户每秒发消息计数 */
export const dmSendRateKey = (userId: number) => `dm:send-rate:${userId}`;

export const DM_CONV_LIST_TTL_SEC = 30;
export const DM_CONV_INFO_TTL_SEC = 60;

/** 单用户发消息频率：每秒 5 条 / 每分钟 60 条（双桶） */
export const DM_SEND_PER_SEC = 5;
export const DM_SEND_PER_MIN = 60;

/** 编辑 / 撤回时间窗（毫秒） */
export const DM_EDIT_WINDOW_MS = 5 * 60 * 1000;
export const DM_WITHDRAW_WINDOW_MS = 5 * 60 * 1000;

/** 发消息内容硬上限 */
export const DM_CONTENT_MAX = 4000;

export const invalidateDmListCache = async (userIds: number[]): Promise<void> => {
  if (!userIds.length) return;
  try {
    const redis = getRedis();
    await Promise.all(userIds.map((id) => redis.del(dmConvListKey(id))));
  } catch {
    /* noop */
  }
};

export const invalidateDmConvInfoCache = async (conversationId: number): Promise<void> => {
  try {
    const redis = getRedis();
    await redis.del(dmConvInfoKey(conversationId));
  } catch {
    /* noop */
  }
};

/* ─────────────────────── 成员判断 ─────────────────────── */

export interface MemberRow {
  id: number;
  role: 'owner' | 'admin' | 'member';
  lastReadAt: string | null;
  muted: boolean;
  pinned: boolean;
  leftAt: string | null;
  user: { id: number } | null;
}

/**
 * 取指定 userId 在指定 conversation 里的当前成员关系（leftAt 为 null）。
 * 不存在或已离开 → 返回 null。
 */
export const findActiveMember = async (
  strapi: Core.Strapi,
  conversationId: number,
  userId: number,
): Promise<MemberRow | null> => {
  if (!Number.isInteger(conversationId) || !Number.isInteger(userId)) return null;
  const row = await strapi.db.query('api::conversation-member.conversation-member').findOne({
    where: {
      conversation: { id: conversationId },
      user: { id: userId },
      leftAt: { $null: true },
    },
    select: ['id', 'role', 'lastReadAt', 'muted', 'pinned', 'leftAt'],
    populate: { user: { select: ['id'] } },
  });
  return row || null;
};

/**
 * 取会话所有未离开成员，含 user.id（用于推送 / 限流 / 权限计算）。
 */
export const listActiveMembers = async (
  strapi: Core.Strapi,
  conversationId: number,
): Promise<MemberRow[]> => {
  if (!Number.isInteger(conversationId)) return [];
  const rows = await strapi.db.query('api::conversation-member.conversation-member').findMany({
    where: {
      conversation: { id: conversationId },
      leftAt: { $null: true },
    },
    select: ['id', 'role', 'lastReadAt', 'muted', 'pinned', 'leftAt'],
    populate: { user: { select: ['id'] } },
  });
  return Array.isArray(rows) ? rows : [];
};

/* ─────────────────────── findExistingDirect ─────────────────────── */

/**
 * 仅查找 (selfId, otherId) 之间已存在的 direct 会话，不创建。
 * - 没找到返回 null
 * - 找到返回会话 id + documentId
 *
 * 用途：notification 创建时为通知附加 conversationId，无现成会话则走 pseudo
 * id；不强制写一条空 DM 会话来污染 DM 表。
 */
export const findExistingDirectConversation = async (
  strapi: Core.Strapi,
  selfId: number,
  otherId: number,
): Promise<{ id: number; documentId: string } | null> => {
  if (!Number.isInteger(selfId) || !Number.isInteger(otherId)) return null;
  if (selfId === otherId) return null;

  const myMembers = await strapi.db
    .query('api::conversation-member.conversation-member')
    .findMany({
      where: {
        user: { id: selfId },
        conversation: { kind: 'direct' },
      },
      select: ['id'],
      populate: { conversation: { select: ['id'] } },
    });
  const myConvIds = (myMembers || [])
    .map((m: any) => m?.conversation?.id)
    .filter((id: unknown): id is number => Number.isInteger(id));
  if (myConvIds.length === 0) return null;

  const otherMembers = await strapi.db
    .query('api::conversation-member.conversation-member')
    .findMany({
      where: {
        user: { id: otherId },
        conversation: { id: { $in: myConvIds } },
      },
      select: ['id', 'leftAt'],
      populate: { conversation: { select: ['id', 'documentId'] } },
    });

  // 优先选双方都未 left 的；都 left 也复用（保留历史）
  let chosen: any = null;
  for (const om of otherMembers || []) {
    if (!om?.conversation?.id) continue;
    if (!chosen) chosen = om;
    if (chosen.leftAt && !om.leftAt) chosen = om;
  }
  if (!chosen) return null;
  return {
    id: chosen.conversation.id,
    documentId: chosen.conversation.documentId,
  };
};

/* ─────────────────────── findOrCreateDirect ─────────────────────── */

/**
 * 私聊冷启动：返回 (selfId, otherId) 之间的唯一 direct 会话；不存在则创建。
 *
 * 幂等关键：
 * - 私聊会话同一对用户**只能有一条**——通过先查后写实现。
 * - 并发场景：同一对用户两端同时点「发消息」，可能两条 INSERT 都成功；
 *   缓解方式见下面注释里的「修复二阶段」。MVP 阶段并发概率低，先接受最多
 *   重复 1 条会话的结果（以最新一条为准，旧的孤立但无害）。
 *
 * 调用前校验：
 * - selfId !== otherId（不能跟自己开聊天）
 * - 双向 block：暂不实现（schema 没有 user.blockedUsers 关系），等产品定后接入
 */
export const findOrCreateDirectConversation = async (
  strapi: Core.Strapi,
  selfId: number,
  otherId: number,
): Promise<{ id: number; documentId: string; isNew: boolean }> => {
  if (!Number.isInteger(selfId) || !Number.isInteger(otherId)) {
    throw new Error('invalid user id');
  }
  if (selfId === otherId) {
    throw new Error('cannot create direct conversation with self');
  }

  // 第一步：穷举两个 user 都在的 direct 会话（含已 leftAt 的）。
  // SQL 思路：
  //   SELECT c.* FROM conversation c
  //   WHERE c.kind = 'direct'
  //   AND EXISTS (member m1 WHERE m1.conv = c AND m1.user = self)
  //   AND EXISTS (member m2 WHERE m2.conv = c AND m2.user = other)
  // Strapi 的 query builder 不支持 multi-EXISTS；采用两步查询：
  //   1) 找 self 参与的所有 direct 会话 id 集合
  //   2) 在 other 的 member 里筛交集
  const myMembers = await strapi.db.query('api::conversation-member.conversation-member').findMany({
    where: {
      user: { id: selfId },
      conversation: { kind: 'direct' },
    },
    select: ['id'],
    populate: { conversation: { select: ['id'] } },
  });
  const myConvIds = new Set(
    (myMembers || [])
      .map((m: any) => m?.conversation?.id)
      .filter((id: unknown): id is number => Number.isInteger(id)),
  );

  if (myConvIds.size > 0) {
    const otherMembers = await strapi.db.query('api::conversation-member.conversation-member').findMany({
      where: {
        user: { id: otherId },
        conversation: { id: { $in: Array.from(myConvIds) } },
      },
      select: ['id', 'leftAt'],
      populate: { conversation: { select: ['id', 'documentId'] } },
    });

    // 优先选双方都未 left 的；都 left 的也复用——这样原会话历史保留。
    // 复用前要把 self 的 leftAt 重置（重新激活成员关系）。
    let chosen: any = null;
    for (const om of otherMembers || []) {
      if (!om?.conversation?.id) continue;
      if (!chosen) chosen = om;
      // 优先双方都活跃：如果 chosen 是已 left 的，但当前是未 left 的，替换
      if (chosen.leftAt && !om.leftAt) chosen = om;
    }

    if (chosen) {
      const convId = chosen.conversation.id;
      const convDocId = chosen.conversation.documentId;
      // 复活 self 的成员关系（若曾 leave）
      const selfMember = await strapi.db.query('api::conversation-member.conversation-member').findOne({
        where: {
          conversation: { id: convId },
          user: { id: selfId },
        },
        select: ['id', 'leftAt'],
      });
      if (selfMember && selfMember.leftAt !== null) {
        await strapi.db.query('api::conversation-member.conversation-member').update({
          where: { id: selfMember.id },
          data: { leftAt: null },
        });
      }
      return { id: convId, documentId: convDocId, isNew: false };
    }
  }

  // 第二步：找不到 → 创建新 conversation + 双方 member
  // 用 documents API 走 lifecycle hooks（未来如果加 conversation lifecycle 会被触发）
  // cast：参考 controller 注释，新 UID 在 IDE 类型联合首次生成前不被识别。
  const conv: any = await (strapi.documents)('api::conversation.conversation').create({
    data: {
      kind: 'direct',
      lastMessageAt: new Date().toISOString(),
    },
  });

  // 注意：Strapi 5 的 db.query.createMany **不处理 relation 字段**——直接把
  // `conversation` / `user` 当成普通列插 NULL，导致 listActiveMembers 后续找不到成员。
  // 必须改用 create 一条条写，让 ORM 把关系字段转成 connect。
  await strapi.db.query('api::conversation-member.conversation-member').create({
    data: { conversation: conv.id, user: selfId, role: 'member' },
  });
  await strapi.db.query('api::conversation-member.conversation-member').create({
    data: { conversation: conv.id, user: otherId, role: 'member' },
  });

  return { id: conv.id, documentId: conv.documentId, isNew: true };
};

/* ─────────────────────── 限流 ─────────────────────── */

/**
 * 双桶滑窗限流：每秒 5 条 + 每分钟 60 条。
 * Redis 不可用时返回 false（fail-open，不限流）——与全局 rate-limit 保持一致风格。
 */
export const checkAndRecordSendRate = async (userId: number): Promise<{
  blocked: boolean;
  retryAfterSec?: number;
}> => {
  if (!Number.isInteger(userId)) return { blocked: false };
  try {
    const redis = getRedis();
    const secKey = `${dmSendRateKey(userId)}:s`;
    const minKey = `${dmSendRateKey(userId)}:m`;

    const [secCount, minCount] = await Promise.all([
      redis.incr(secKey),
      redis.incr(minKey),
    ]);
    if (secCount === 1) await redis.expire(secKey, 1);
    if (minCount === 1) await redis.expire(minKey, 60);

    if (secCount > DM_SEND_PER_SEC) {
      const ttl = await redis.ttl(secKey);
      return { blocked: true, retryAfterSec: ttl > 0 ? ttl : 1 };
    }
    if (minCount > DM_SEND_PER_MIN) {
      const ttl = await redis.ttl(minKey);
      return { blocked: true, retryAfterSec: ttl > 0 ? ttl : 60 };
    }
    return { blocked: false };
  } catch {
    return { blocked: false };
  }
};
