import type { Core } from '@strapi/strapi';
/**
 * conversation controller —— DM 会话相关 API。
 *
 * 路由（全部挂在 /api/dm/* 前缀）：
 *   GET    /api/dm/conversations               list      会话列表
 *   POST   /api/dm/conversations/direct        direct    找/建私聊
 *   POST   /api/dm/conversations/group         createGroup  建群
 *   GET    /api/dm/conversations/:id           detail    会话详情 + 成员
 *   PATCH  /api/dm/conversations/:id           update    改 muted/pinned/title
 *   PATCH  /api/dm/conversations/:id/read      markRead  标已读
 *   POST   /api/dm/conversations/:id/leave     leave     离开 / 私聊退出
 *   POST   /api/dm/conversations/:id/members   addMembers    群聊加人（owner/admin）
 *   DELETE /api/dm/conversations/:id/members/:userId removeMember 群聊移除成员/退群
 *   POST   /api/dm/socket/ticket               wsTicket  签发 WS ticket
 *
 * 与现有 notification/敲敲 是兄弟模块，不共享 controller 但都遵循
 * 「失败 fail-open Redis、写入路径主动 invalidate 缓存」相同风格。
 */
import { factories } from '@strapi/strapi';
import { withSmallWebp, batchResolveEquippedAvatars, getErrorMessage } from '../../../utils/common';
import { getRedis } from '../../../utils/redis';
import {
  dmConvListKey,
  DM_CONV_LIST_TTL_SEC,
  invalidateDmListCache,
  invalidateDmConvInfoCache,
  findActiveMember,
  listActiveMembers,
  findOrCreateDirectConversation,
} from '../utils/dm-helpers';
import {
  decodePseudoConvId,
  fetchNotificationsForUser,
  groupNotifications,
  isPseudoConvId,
  markBucketNotificationsRead,
  mergeDmListWithNotificationBuckets,
} from '../utils/notification-merge';
import { issueTicket } from '../utils/ws-auth';
import { publishToUser, publishToUsers } from '../utils/ws-bus';
import { buildSenderResolver, serializeMessage } from '../../message/utils/serialize';
import { DM_RESET_MARKER } from '../../../utils/agent/dm-reset';

const MAX_MESSAGE_PREVIEW_LEN = 80;

/** 群聊人数上限（含群主）。产品侧可按需调整。 */
const GROUP_MAX_MEMBERS = 20;

const nowIso = () => new Date().toISOString();

/**
 * 解析加群成员：兼容 memberUserIds（内部 user id）与 memberAuthorIds
 * （author documentId，前端关注列表/搜索随处可得）。返回去重后的 user id 列表。
 */
async function resolveGroupMemberIds(
  strapi: Core.Strapi,
  body: Record<string, unknown>,
  excludeUserId: number,
): Promise<number[]> {
  const rawUserIds = Array.isArray(body.memberUserIds) ? (body.memberUserIds as unknown[]) : [];
  const byUserId = Array.from(
    new Set(
      rawUserIds
        .map((v) => Number.parseInt(String(v), 10))
        .filter((v: number) => Number.isInteger(v) && v > 0 && v !== excludeUserId),
    ),
  );
  if (byUserId.length > 0) return byUserId;

  const rawAuthorIds = Array.isArray(body.memberAuthorIds) ? (body.memberAuthorIds as unknown[]) : [];
  const authorDocIds = Array.from(
    new Set(
      rawAuthorIds
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean),
    ),
  );
  if (authorDocIds.length === 0) return [];

  const authors = await strapi.db.query('api::author.author').findMany({
    where: { documentId: { $in: authorDocIds } },
    select: ['id'],
    populate: { user: { select: ['id'] } },
    limit: authorDocIds.length,
  });
  return (authors || [])
    .map((a: any) => a?.user?.id)
    .filter((id: unknown): id is number => Number.isInteger(id) && id !== excludeUserId);
}

const stripContentForPreview = (content: string | null | undefined): string => {
  if (!content) return '';
  // M3 阶段会接入 stripMentionsToPlain（处理 @[name](id) → @name），这里先朴素截断
  return content.length > MAX_MESSAGE_PREVIEW_LEN
    ? content.slice(0, MAX_MESSAGE_PREVIEW_LEN) + '…'
    : content;
};

/* ─────────────────── 序列化辅助 ─────────────────── */

/**
 * 批量序列化多个会话——专为 list 接口设计，避免 N+1：
 *  - 1 次 query 拿所有会话的 active members（用 conversation IN）
 *  - 1 次 query 拿所有 peer 的 author + avatar
 *  - 1 次 batchResolveEquippedAvatars 拿所有装备头像
 *  - 1 次 query 批量统计所有会话的未读数（$or 拼每会话条件，内存计数）
 *
 * 之前 serializeConversationLite 串行调用，50 会话 = 4N+1 = 201 queries；
 * 改批量后 = 3 (members / authors / avatars) + 1 (批量未读统计) = ~4 queries，
 * 与会话数无关。
 *
 * 注意：单条创建路径（direct 接口）仍用 serializeConversationLite，
 * 因为只有 1 条会话，N+1 不成立。
 */
const serializeConversationsBatch = async (
  strapi: Core.Strapi,
  convs: any[],
  selfUserId: number,
): Promise<any[]> => {
  if (convs.length === 0) return [];

  const convIds = convs.map((c) => c.id).filter((id): id is number => Number.isInteger(id));
  if (convIds.length === 0) return [];

  // 1) 批量查所有 conv 的 active members
  const allMembers = await strapi.db.query('api::conversation-member.conversation-member').findMany({
    where: {
      conversation: { id: { $in: convIds } },
      leftAt: { $null: true },
    },
    select: ['id', 'role', 'lastReadAt', 'muted', 'pinned'],
    populate: {
      user: { select: ['id'] },
      conversation: { select: ['id'] },
    },
  });

  // 按 convId 分组
  const membersByConv = new Map<number, any[]>();
  for (const m of allMembers) {
    const cid = m?.conversation?.id;
    if (!Number.isInteger(cid)) continue;
    let list = membersByConv.get(cid);
    if (!list) {
      list = [];
      membersByConv.set(cid, list);
    }
    list.push(m);
  }

  // 2) 收集所有 peer userIds（私聊场景：除了 self 的对端）
  const peerUserIds = new Set<number>();
  for (const conv of convs) {
    if (conv.kind !== 'direct') continue;
    const list = membersByConv.get(conv.id) || [];
    for (const m of list) {
      const uid = m?.user?.id;
      if (Number.isInteger(uid) && uid !== selfUserId) peerUserIds.add(uid);
    }
  }

  // 3) 批量查 peer authors
  const peerIdsArr = Array.from(peerUserIds);
  const authorRows = peerIdsArr.length
    ? await strapi.db.query('api::author.author').findMany({
        where: { user: { id: { $in: peerIdsArr } } },
        select: ['documentId', 'name'],
        populate: {
          avatar: { select: ['url', 'width', 'height'] },
          user: { select: ['id', 'level', 'username', 'profileHidden', 'isAiAgent'] },
        },
      })
    : [];
  const authorByUserId = new Map<number, any>();
  for (const a of authorRows) {
    const uid = a?.user?.id;
    if (Number.isInteger(uid)) authorByUserId.set(uid, a);
  }

  // 4) 批量解析装备头像
  const avatarMap = peerIdsArr.length
    ? await batchResolveEquippedAvatars(strapi, peerIdsArr)
    : new Map<number, any>();

  // 5) 一次性批量统计未读数，替代过去「每会话一次 count」的 N+1。
  //    每个会话的未读判定 =「非自己发送 + 未删除 + createdAt > 该会话的 lastReadAt」，
  //    各会话 lastReadAt 不同，故用 $or 把每会话条件拼成一条查询：只取实际未读的消息
  //    （数量受 UI 未读上限约束，天然较小），再在内存里按会话计数。
  const unreadByConv = new Map<number, number>();
  const unreadClauses: any[] = [];
  for (const conv of convs) {
    const self = (membersByConv.get(conv.id) || []).find((m) => m?.user?.id === selfUserId);
    if (!self) continue;
    const clause: any = { conversation: { id: conv.id } };
    if (self.lastReadAt) clause.createdAt = { $gt: self.lastReadAt };
    unreadClauses.push(clause);
  }
  if (unreadClauses.length > 0) {
    const unreadMsgs = await strapi.db.query('api::message.message').findMany({
      where: {
        sender: { id: { $ne: selfUserId } },
        deletedAt: { $null: true },
        $or: unreadClauses,
      },
      select: ['id'],
      populate: { conversation: { select: ['id'] } },
    });
    for (const msg of unreadMsgs) {
      const cid = msg?.conversation?.id;
      if (!Number.isInteger(cid)) continue;
      unreadByConv.set(cid, (unreadByConv.get(cid) || 0) + 1);
    }
  }

  const out: any[] = [];
  for (const conv of convs) {
    const members = membersByConv.get(conv.id) || [];
    const self = members.find((m) => m?.user?.id === selfUserId);
    if (!self) continue;
    const others = members.filter((m) => m?.user?.id !== selfUserId);

    let peer: any = null;
    if (conv.kind === 'direct' && others.length > 0) {
      const peerUserId = others[0]?.user?.id;
      if (Number.isInteger(peerUserId)) {
        const author = authorByUserId.get(peerUserId);
        const equipped = avatarMap.get(peerUserId);
        const avatar = equipped
          ? withSmallWebp(equipped)
          : author?.avatar
            ? withSmallWebp(author.avatar)
            : null;
        peer = author
          ? {
              userId: peerUserId,
              authorDocumentId: author.documentId,
              name: author.name || author?.user?.username || '未知用户',
              avatar: avatar?.url ?? null,
              level: author?.user?.level ?? null,
              isAiAgent: author?.user?.isAiAgent === true,
            }
          : null;
      }
    }

    // unread count 取自上方一次性批量统计的结果（不再逐会话 query）
    const unreadCount = unreadByConv.get(conv.id) ?? 0;

    // lastMessage 预览（与单条版本同口径）
    let lastMessage: any = null;
    if (conv.lastMessage?.id) {
      lastMessage = {
        documentId: conv.lastMessage.documentId,
        content:
          conv.lastMessage.kind === 'system'
            ? stripContentForPreview(conv.lastMessage.content)
            : conv.lastMessage.deletedAt
              ? '[消息已撤回]'
              : conv.lastMessage.kind === 'image'
                ? '[图片]'
                : stripContentForPreview(conv.lastMessage.content),
        createdAt: conv.lastMessage.createdAt,
        kind: conv.lastMessage.kind,
        senderUserId: conv.lastMessage.sender?.id ?? null,
      };
    }

    out.push({
      documentId: conv.documentId,
      kind: conv.kind,
      title: conv.kind === 'group' ? conv.title : peer?.name ?? null,
      avatar: conv.kind === 'group' ? (conv.avatar ? withSmallWebp(conv.avatar)?.url ?? null : null) : peer?.avatar ?? null,
      peer,
      memberCount: members.length,
      lastMessageAt: conv.lastMessageAt,
      lastMessage,
      unreadCount,
      self: {
        role: self.role,
        muted: self.muted,
        pinned: self.pinned,
        lastReadAt: self.lastReadAt,
      },
    });
  }
  return out;
};

const serializeConversationLite = async (
  strapi: Core.Strapi,
  conv: any,
  selfUserId: number,
): Promise<any | null> => {
  if (!conv?.id) return null;

  const members = await listActiveMembers(strapi, conv.id);
  const self = members.find((m) => m?.user?.id === selfUserId);
  if (!self) return null; // 调用方应已过滤；多一层保护

  // peer：私聊时是另一方；群聊时为 null（前端直接用 conv.title / conv.avatar）
  const others = members.filter((m) => m?.user?.id !== selfUserId);

  let peer: any = null;
  if (conv.kind === 'direct' && others.length > 0) {
    const peerUserId = others[0]?.user?.id;
    if (Number.isInteger(peerUserId)) {
      const author = await strapi.db.query('api::author.author').findOne({
        where: { user: peerUserId },
        select: ['documentId', 'name'],
        populate: {
          avatar: { select: ['url', 'width', 'height'] },
          user: { select: ['id', 'level', 'username', 'profileHidden', 'isAiAgent'] },
        },
      });
      // 装备头像
      const avatarMap = await batchResolveEquippedAvatars(strapi, [peerUserId]);
      const equipped = avatarMap.get(peerUserId);
      const avatar = equipped
        ? withSmallWebp(equipped)
        : author?.avatar
          ? withSmallWebp(author.avatar)
          : null;
      peer = author
        ? {
            userId: peerUserId,
            authorDocumentId: author.documentId,
            name: author.name || author?.user?.username || '未知用户',
            avatar: avatar?.url ?? null,
            level: author?.user?.level ?? null,
            isAiAgent: author?.user?.isAiAgent === true,
          }
        : null;
    }
  }

  // 未读数：count(messages where conversation = X AND sender != self AND createdAt > self.lastReadAt AND deletedAt is null)
  const unreadWhere: any = {
    conversation: { id: conv.id },
    sender: { id: { $ne: selfUserId } },
    deletedAt: { $null: true },
  };
  if (self.lastReadAt) {
    unreadWhere.createdAt = { $gt: self.lastReadAt };
  }
  const unreadCount = await strapi.db.query('api::message.message').count({ where: unreadWhere });

  // 最后一条消息预览
  let lastMessage: any = null;
  if (conv.lastMessage?.id) {
    lastMessage = {
      documentId: conv.lastMessage.documentId,
      content:
        conv.lastMessage.kind === 'system'
          ? stripContentForPreview(conv.lastMessage.content)
          : conv.lastMessage.deletedAt
            ? '[消息已撤回]'
            : conv.lastMessage.kind === 'image'
              ? '[图片]'
              : stripContentForPreview(conv.lastMessage.content),
      createdAt: conv.lastMessage.createdAt,
      kind: conv.lastMessage.kind,
      senderUserId: conv.lastMessage.sender?.id ?? null,
    };
  }

  return {
    documentId: conv.documentId,
    kind: conv.kind,
    title: conv.kind === 'group' ? conv.title : peer?.name ?? null,
    avatar: conv.kind === 'group' ? (conv.avatar ? withSmallWebp(conv.avatar)?.url ?? null : null) : peer?.avatar ?? null,
    peer, // 私聊时含对端信息；群聊时 null
    memberCount: members.length,
    lastMessageAt: conv.lastMessageAt,
    lastMessage,
    unreadCount,
    self: {
      role: self.role,
      muted: self.muted,
      pinned: self.pinned,
      lastReadAt: self.lastReadAt,
    },
  };
};

export default factories.createCoreController(
  'api::conversation.conversation',
  ({ strapi }) => ({
    /**
     * GET /api/dm/conversations
     * 当前用户参与的所有未离开会话；按 pinned desc, lastMessageAt desc 排序。
     */
    async list(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      // 缓存命中
      try {
        const redis = getRedis();
        const cached = await redis.get(dmConvListKey(user.id));
        if (cached) {
          ctx.send(JSON.parse(cached));
          return;
        }
      } catch {
        /* fail-open */
      }

      // 当前用户的所有 active member 行
      const myMembers = await strapi.db.query('api::conversation-member.conversation-member').findMany({
        where: {
          user: { id: user.id },
          leftAt: { $null: true },
        },
        select: ['id', 'role', 'lastReadAt', 'muted', 'pinned'],
        populate: {
          conversation: {
            select: ['id', 'documentId', 'kind', 'title', 'lastMessageAt'],
            populate: {
              avatar: { select: ['url', 'width', 'height'] },
              lastMessage: {
                select: ['id', 'documentId', 'content', 'createdAt', 'kind', 'deletedAt'],
                populate: { sender: { select: ['id'] } },
              },
            },
          },
        },
      });

      const conversations = (myMembers || [])
        .map((m: any) => m?.conversation)
        .filter((c: any) => c?.id);

      // 批量序列化——3 个批量 query + N 个 count，避免之前 4N+1 的 N+1 问题
      const summaries = await serializeConversationsBatch(strapi, conversations, user.id);

      // 排序：pinned desc, lastMessageAt desc
      summaries.sort((a: any, b: any) => {
        const aPin = a.self?.pinned ? 1 : 0;
        const bPin = b.self?.pinned ? 1 : 0;
        if (aPin !== bPin) return bPin - aPin;
        const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
        const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
        return bt - at;
      });

      // 会话融合：把通知按 sender 聚合后并入 DM 列表。
      //  - 已有 DM 会话的 sender → unread 累加 + lastMessage 取较新
      //  - 还没 DM 的 sender → 生成 pseudo:user:${senderId} 项
      //  - 匿名通知 / 系统通知 → 各自 pseudo:anonymous / pseudo:system 项
      // 失败 fail-open：通知拉取失败不阻断 DM 列表返回
      let merged = summaries;
      try {
        const notifRows = await fetchNotificationsForUser(strapi, user.id);
        if (notifRows.length) {
          const buckets = groupNotifications(notifRows);
          if (buckets.size > 0) {
            merged = await mergeDmListWithNotificationBuckets(strapi, summaries, buckets);
          }
        }
      } catch (err) {
        strapi.log?.warn?.('[dm.list] notification merge failed; falling back to pure DM', err);
      }

      const payload = { data: merged };

      try {
        const redis = getRedis();
        await redis.set(dmConvListKey(user.id), JSON.stringify(payload), 'EX', DM_CONV_LIST_TTL_SEC);
      } catch {
        /* noop */
      }

      ctx.send(payload);
    },

    /**
     * POST /api/dm/conversations/direct
     * body: { targetUserId: number }
     * 找或建私聊会话；幂等。
     */
    async direct(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const body = (ctx.request?.body)?.data || ctx.request?.body || {};
      const targetUserIdRaw = body?.targetUserId ?? body?.userId;
      const targetUserId = Number.parseInt(String(targetUserIdRaw), 10);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return ctx.badRequest('targetUserId required');
      }
      if (targetUserId === user.id) {
        return ctx.badRequest('cannot start direct conversation with self');
      }

      // 验证对端存在 + 未被封禁
      const target = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: targetUserId },
        select: ['id', 'blocked', 'confirmed'],
      });
      if (!target) return ctx.notFound('target user not found');
      if (target.blocked === true || target.confirmed === false) {
        return ctx.forbidden('target user not available');
      }

      let result: { id: number; documentId: string; isNew: boolean };
      try {
        result = await findOrCreateDirectConversation(strapi, user.id, targetUserId);
      } catch (err: unknown) {
        return ctx.badRequest(getErrorMessage(err) || 'failed to find/create conversation');
      }

      // 缓存失效（双方）
      await invalidateDmListCache([user.id, targetUserId]);
      await invalidateDmConvInfoCache(result.id);

      // 序列化返回
      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { id: result.id },
        select: ['id', 'documentId', 'kind', 'title', 'lastMessageAt'],
        populate: {
          avatar: { select: ['url', 'width', 'height'] },
          lastMessage: {
            select: ['id', 'documentId', 'content', 'createdAt', 'kind', 'deletedAt'],
            populate: { sender: { select: ['id'] } },
          },
        },
      });
      const summary = await serializeConversationLite(strapi, conv, user.id);
      if (!summary) {
        // 走到这里通常说明 conversation_member 没正确建立（如关系字段写丢）。
        // 直接 500 比静默返回 data:null 让前端再炸更易排障。
        strapi.log.error(
          `[dm.direct] serializeConversationLite returned null for conv=${result.id} user=${user.id}`,
        );
        return ctx.internalServerError('failed to serialize conversation');
      }

      ctx.send({ data: summary, isNew: result.isNew });
    },

    /**
     * POST /api/dm/conversations/group
     * 创建群聊：title 必填（1-64 字符）；成员用 memberUserIds 或 memberAuthorIds。
     * 创建者自动成为 owner；成员上限 GROUP_MAX_MEMBERS（含创建者）。
     */
    async createGroup(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const body = (ctx.request?.body)?.data || ctx.request?.body || {};
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 64) {
        return ctx.badRequest('title required (1-64 chars)');
      }

      const memberIds = await resolveGroupMemberIds(strapi, body, user.id);
      if (memberIds.length < 1) {
        return ctx.badRequest('至少选择 1 位群成员');
      }

      // 校验成员存在且未封禁
      const memberUsers = await strapi.db.query('plugin::users-permissions.user').findMany({
        where: { id: { $in: memberIds } },
        select: ['id', 'blocked', 'confirmed'],
        limit: memberIds.length,
      });
      const validIds = (memberUsers || [])
        .filter((u: any) => u?.blocked !== true && u?.confirmed !== false)
        .map((u: any) => u.id)
        .filter((id: unknown): id is number => Number.isInteger(id))
        .slice(0, GROUP_MAX_MEMBERS - 1);

      if (validIds.length === 0) {
        return ctx.badRequest('没有可用的群成员');
      }

      // 创建会话（documents API 走 lifecycle；owner 关系单独回填）
      const conv: any = await (strapi.documents)('api::conversation.conversation').create({
        data: {
          kind: 'group',
          title,
          lastMessageAt: nowIso(),
        },
      });
      await strapi.db.query('api::conversation.conversation').update({
        where: { id: conv.id },
        data: { owner: user.id },
      });

      // 逐条创建 member（Strapi 5 的 db.query.createMany 不处理 relation 字段）
      await strapi.db.query('api::conversation-member.conversation-member').create({
        data: { conversation: conv.id, user: user.id, role: 'owner' },
      });
      for (const uid of validIds) {
        await strapi.db.query('api::conversation-member.conversation-member').create({
          data: { conversation: conv.id, user: uid, role: 'member' },
        });
      }

      const allUserIds = [user.id, ...validIds];
      await invalidateDmListCache(allUserIds);
      await invalidateDmConvInfoCache(conv.id);

      // WS 通知所有成员刷新会话列表（member.added 事件声明于 ws-bus，此处首次启用）
      publishToUsers(allUserIds, {
        type: 'conversation.member.added',
        conversationId: conv.documentId,
        data: { userIds: validIds, addedBy: user.id, title },
        at: nowIso(),
      });

      // 序列化返回（给创建者视角）
      const convRow = await strapi.db.query('api::conversation.conversation').findOne({
        where: { id: conv.id },
        select: ['id', 'documentId', 'kind', 'title', 'lastMessageAt'],
        populate: {
          avatar: { select: ['url', 'width', 'height'] },
          lastMessage: {
            select: ['id', 'documentId', 'content', 'createdAt', 'kind', 'deletedAt'],
            populate: { sender: { select: ['id'] } },
          },
        },
      });
      const summary = await serializeConversationLite(strapi, convRow, user.id);
      if (!summary) {
        return ctx.internalServerError('failed to serialize conversation');
      }

      ctx.send({ data: summary, isNew: true });
    },

    /**
     * POST /api/dm/conversations/:id/members
     * 群聊加人（owner/admin）。body: { memberUserIds } 或 { memberAuthorIds }
     */
    async addMembers(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
      });
      if (!conv) return ctx.notFound();
      if (conv.kind !== 'group') return ctx.badRequest('仅群聊支持添加成员');

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');
      if (myMember.role !== 'owner' && myMember.role !== 'admin') {
        return ctx.forbidden('only owner/admin can add members');
      }

      const body = (ctx.request?.body)?.data || ctx.request?.body || {};
      const memberIds = await resolveGroupMemberIds(strapi, body, user.id);

      if (memberIds.length === 0) return ctx.badRequest('memberUserIds required');

      // 现有成员数（含已退出的不占名额）与上限校验
      const activeMembers = await listActiveMembers(strapi, conv.id);
      const activeUserIds = new Set(
        activeMembers.map((m: any) => m?.user?.id).filter(Number.isInteger),
      );
      const toAdd: number[] = [];
      for (const uid of memberIds) {
        if (activeUserIds.has(uid)) continue; // 已在群里：幂等跳过
        if (activeUserIds.size + toAdd.length + 1 > GROUP_MAX_MEMBERS) break;
        toAdd.push(uid);
      }
      if (toAdd.length === 0) {
        return ctx.badRequest('成员已在群里或超出群人数上限');
      }

      const memberUsers = await strapi.db.query('plugin::users-permissions.user').findMany({
        where: { id: { $in: toAdd } },
        select: ['id', 'blocked', 'confirmed'],
        limit: toAdd.length,
      });
      const validIds = (memberUsers || [])
        .filter((u: any) => u?.blocked !== true && u?.confirmed !== false)
        .map((u: any) => u.id)
        .filter((id: unknown): id is number => Number.isInteger(id));
      if (validIds.length === 0) return ctx.badRequest('没有可用的群成员');

      for (const uid of validIds) {
        // 曾在群里（leftAt 非空）→ 复活记录，保留历史；否则新建
        const existing = await strapi.db
          .query('api::conversation-member.conversation-member')
          .findOne({
            where: { conversation: { id: conv.id }, user: { id: uid } },
            select: ['id', 'leftAt'],
          });
        if (existing) {
          await strapi.db.query('api::conversation-member.conversation-member').update({
            where: { id: existing.id },
            data: { leftAt: null, role: 'member' },
          });
        } else {
          await strapi.db.query('api::conversation-member.conversation-member').create({
            data: { conversation: conv.id, user: uid, role: 'member' },
          });
        }
      }

      const allUserIds = [...activeUserIds, ...validIds].filter(Number.isInteger) as number[];
      await invalidateDmListCache(allUserIds);
      await invalidateDmConvInfoCache(conv.id);

      publishToUsers(allUserIds, {
        type: 'conversation.member.added',
        conversationId: conv.documentId,
        data: { userIds: validIds, addedBy: user.id },
        at: nowIso(),
      });

      ctx.send({ success: true, addedUserIds: validIds });
    },

    /**
     * DELETE /api/dm/conversations/:id/members/:userId
     * 移出群聊（owner/admin 可移除任意成员；普通成员只能移除自己 = 退群）。
     */
    async removeMember(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      const targetUserId = Number.parseInt(String(ctx.params?.userId || ''), 10);
      if (!docId) return ctx.badRequest('conversation id required');
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return ctx.badRequest('userId required');
      }

      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
      });
      if (!conv) return ctx.notFound();
      if (conv.kind !== 'group') return ctx.badRequest('仅群聊支持移除成员');

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const isSelf = targetUserId === user.id;
      const isManager = myMember.role === 'owner' || myMember.role === 'admin';
      if (!isSelf && !isManager) {
        return ctx.forbidden('only owner/admin can remove other members');
      }

      const targetMember = await strapi.db
        .query('api::conversation-member.conversation-member')
        .findOne({
          where: { conversation: { id: conv.id }, user: { id: targetUserId } },
          select: ['id', 'leftAt', 'role'],
        });
      if (!targetMember || targetMember.leftAt !== null) {
        return ctx.badRequest('member not in conversation');
      }
      // owner 不能被移出（包括自己退群前需先转让；M1 简化：owner 不允许退出）
      if (targetMember.role === 'owner') {
        return ctx.badRequest('群主不能被移出或退出群聊');
      }

      await strapi.db.query('api::conversation-member.conversation-member').update({
        where: { id: targetMember.id },
        data: { leftAt: nowIso() },
      });

      const activeMembers = await listActiveMembers(strapi, conv.id);
      const remainingUserIds = activeMembers
        .map((m: any) => m?.user?.id)
        .filter(Number.isInteger) as number[];
      await invalidateDmListCache([...remainingUserIds, targetUserId]);
      await invalidateDmConvInfoCache(conv.id);

      publishToUsers([...remainingUserIds, targetUserId], {
        type: 'conversation.member.removed',
        conversationId: conv.documentId,
        data: { userId: targetUserId, removedBy: user.id },
        at: nowIso(),
      });

      ctx.send({ success: true });
    },

    /**
     * GET /api/dm/conversations/:id
     * 会话详情：含成员（user + author 简要信息）。
     */
    async detail(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind', 'title', 'lastMessageAt'],
        populate: {
          avatar: { select: ['url', 'width', 'height'] },
          owner: { select: ['id'] },
        },
      });
      if (!conv) return ctx.notFound();

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const members = await listActiveMembers(strapi, conv.id);
      const userIds = members
        .map((m) => m?.user?.id)
        .filter((id: unknown): id is number => Number.isInteger(id));

      // 批量取 author 信息
      const authors = userIds.length
        ? await strapi.db.query('api::author.author').findMany({
            where: { user: { id: { $in: userIds } } },
            select: ['documentId', 'name'],
            populate: {
              avatar: { select: ['url', 'width', 'height'] },
              user: { select: ['id', 'username', 'level'] },
            },
          })
        : [];
      const authorByUserId = new Map<number, any>();
      for (const a of authors || []) {
        const uid = a?.user?.id;
        if (Number.isInteger(uid)) authorByUserId.set(uid, a);
      }
      const avatarMap = await batchResolveEquippedAvatars(strapi, userIds);

      const memberRows = members.map((m) => {
        const uid = m.user?.id ?? null;
        const author = uid != null ? authorByUserId.get(uid) : null;
        const equipped = uid != null ? avatarMap.get(uid) : null;
        const avatar = equipped
          ? withSmallWebp(equipped)
          : author?.avatar
            ? withSmallWebp(author.avatar)
            : null;
        return {
          userId: uid,
          authorDocumentId: author?.documentId ?? null,
          name: author?.name || author?.user?.username || '未知用户',
          avatar: avatar?.url ?? null,
          level: author?.user?.level ?? null,
          role: m.role,
          isSelf: uid === user.id,
        };
      });

      ctx.send({
        data: {
          documentId: conv.documentId,
          kind: conv.kind,
          title: conv.title,
          avatar: conv.avatar ? withSmallWebp(conv.avatar)?.url ?? null : null,
          ownerUserId: (conv).owner?.id ?? null,
          lastMessageAt: conv.lastMessageAt,
          self: {
            role: myMember.role,
            muted: myMember.muted,
            pinned: myMember.pinned,
            lastReadAt: myMember.lastReadAt,
          },
          members: memberRows,
        },
      });
    },

    /**
     * PATCH /api/dm/conversations/:id
     * 更新会话级 / 个人偏好属性。
     *  - muted / pinned：自己可改
     *  - title / avatar：群聊且自己 owner|admin 才能改；私聊不允许
     */
    async update(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
      });
      if (!conv) return ctx.notFound();

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const body = (ctx.request?.body)?.data || ctx.request?.body || {};
      const memberPatch: Record<string, unknown> = {};
      const convPatch: Record<string, unknown> = {};

      if (typeof body.muted === 'boolean') memberPatch.muted = body.muted;
      if (typeof body.pinned === 'boolean') memberPatch.pinned = body.pinned;

      if (typeof body.title === 'string') {
        if (conv.kind !== 'group') return ctx.badRequest('only group conversation can have title');
        if (myMember.role !== 'owner' && myMember.role !== 'admin') {
          return ctx.forbidden('not allowed');
        }
        const title = body.title.trim().slice(0, 64);
        convPatch.title = title;
      }

      if (Object.keys(memberPatch).length > 0) {
        await strapi.db.query('api::conversation-member.conversation-member').update({
          where: { id: myMember.id },
          data: memberPatch,
        });
      }
      if (Object.keys(convPatch).length > 0) {
        await strapi.db.query('api::conversation.conversation').update({
          where: { id: conv.id },
          data: convPatch,
        });
      }

      // 失效缓存 + 通知会话内所有成员
      const members = await listActiveMembers(strapi, conv.id);
      const userIds = members.map((m) => m.user?.id).filter((id): id is number => Number.isInteger(id));
      await invalidateDmListCache(userIds);
      await invalidateDmConvInfoCache(conv.id);

      if (Object.keys(convPatch).length > 0) {
        publishToUsers(userIds, {
          type: 'conversation.updated',
          conversationId: conv.documentId,
          data: convPatch,
          at: nowIso(),
        });
      }

      ctx.send({ data: { ok: true } });
    },

    /**
     * PATCH /api/dm/conversations/:id/read
     * 标记当前用户已读到 now；推 dm.conversation.read 事件给该用户其它端（多端同步）。
     */
    async markRead(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      // ── 分支 1：pseudo 会话 ─────────────────────────
      // pseudo:user / pseudo:anonymous / pseudo:system —— 仅标对应桶通知 isRead=true，
      // 没有 conversation-member 表项要更新。同步推 ws 让其它端的 unread 落地。
      if (isPseudoConvId(docId)) {
        const decoded = decodePseudoConvId(docId);
        if (!decoded) return ctx.badRequest('invalid pseudo conversation id');

        const updatedCount = await markBucketNotificationsRead(strapi, user.id, decoded);
        const at = nowIso();
        if (updatedCount > 0) {
          // 失效 DM 列表缓存（unread 已变化）
          await invalidateDmListCache([user.id]);
          // 同步 invalidate 敲敲老接口的缓存（保持 /api/knock/conversations 也准确）
          try {
            const redis = getRedis();
            await redis.del(`knock:conv:${user.id}`);
          } catch {
            /* noop */
          }
          publishToUser(user.id, {
            type: 'conversation.read',
            conversationId: docId,
            data: { lastReadAt: at, updatedCount },
            at,
          });
        }
        ctx.send({ data: { lastReadAt: at, updatedCount } });
        return;
      }

      // ── 分支 2：真 DM 会话 ─────────────────────────
      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
      });
      if (!conv) return ctx.notFound();

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const lastReadAt = nowIso();
      await strapi.db.query('api::conversation-member.conversation-member').update({
        where: { id: myMember.id },
        data: { lastReadAt },
      });

      // 同步把对端给 self 的所有 contacts 通知也标已读（DM 与通知合并视图下的语义一致性：
      // 用户点开会话 = 既看了 DM 也看了通知）
      // 仅 direct 会话有意义；group 暂不做 notification 联动
      let notifMarked = 0;
      if (conv.kind === 'direct') {
        try {
          const otherMembers = await listActiveMembers(strapi, conv.id);
          const peer = (otherMembers || []).find((m) => m?.user?.id !== user.id);
          const peerUserId = peer?.user?.id;
          if (Number.isInteger(peerUserId)) {
            notifMarked = await markBucketNotificationsRead(strapi, user.id, {
              kind: 'contacts-user',
              senderUserId: peerUserId,
            });
          }
        } catch (err) {
          strapi.log?.warn?.('[dm.markRead] notification mark-read failed', err);
        }
      }

      await invalidateDmListCache([user.id]);
      if (notifMarked > 0) {
        // 失效敲敲老接口缓存（保持 /api/knock/conversations 也准确）
        try {
          const redis = getRedis();
          await redis.del(`knock:conv:${user.id}`);
        } catch {
          /* noop */
        }
      }

      // 多端同步：自己其它端的 ws 连接也通知
      publishToUser(user.id, {
        type: 'conversation.read',
        conversationId: conv.documentId,
        data: { lastReadAt, notifMarked },
        at: lastReadAt,
      });

      ctx.send({ data: { lastReadAt, notifMarked } });
    },

    /**
     * POST /api/dm/conversations/:id/leave
     * 离开会话。私聊：双方任一方离开后该会话不出现在双方列表（保留历史）。
     * 群聊：member.leftAt = now；如果 owner 离开且有其它成员，自动转让给最早的 admin / member。
     */
    async leave(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
        populate: { owner: { select: ['id'] } },
      });
      if (!conv) return ctx.notFound();

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const leftAt = nowIso();
      await strapi.db.query('api::conversation-member.conversation-member').update({
        where: { id: myMember.id },
        data: { leftAt },
      });

      // 群聊 owner 转让（M1 简化：owner 离开不改 owner，下一阶段再做）
      // 私聊：另一端的会话列表也要 invalidate
      const others = (await listActiveMembers(strapi, conv.id))
        .map((m) => m.user?.id)
        .filter((id): id is number => Number.isInteger(id));

      await invalidateDmListCache([user.id, ...others]);
      await invalidateDmConvInfoCache(conv.id);

      // 通知其它在线成员
      publishToUsers(others, {
        type: 'conversation.member.removed',
        conversationId: conv.documentId,
        data: { userId: user.id },
        at: leftAt,
      });

      ctx.send({ data: { ok: true } });
    },

    /**
     * POST /api/dm/conversations/:id/reset-context
     * 重置 AI 对话上下文（3.3.4）：写入一条 kind:'system' 分界消息并广播。
     * 不删除任何历史；后续 AI 回复只读取该分界之后的消息，等效「清空记忆开新话题」。
     */
    async resetContext(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
      });
      if (!conv) return ctx.notFound();

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const created: any = await (strapi.documents)('api::message.message').create({
        data: {
          conversation: conv.id,
          sender: user.id,
          content: DM_RESET_MARKER,
          kind: 'system',
        },
      });

      const members = await listActiveMembers(strapi, conv.id);
      const memberUserIds = members
        .map((m) => m.user?.id)
        .filter((id): id is number => Number.isInteger(id));

      const detail: any = await strapi.db.query('api::message.message').findOne({
        where: { id: created.id },
        select: ['id', 'documentId', 'content', 'createdAt', 'editedAt', 'deletedAt', 'kind'],
        populate: { sender: { select: ['id'] } },
      });
      const senderMap = await buildSenderResolver(strapi, [user.id]);
      const serialized = serializeMessage(detail, senderMap);

      publishToUsers(memberUserIds, {
        type: 'message.created',
        conversationId: conv.documentId,
        messageId: detail.documentId,
        data: { message: serialized },
        at: detail.createdAt,
      });

      ctx.send({ data: serialized });
    },

    /**
     * POST /api/dm/socket/ticket
     * 签发一次性 30s WS ticket。客户端拿到后 wss://.../dm/socket?ticket=xxx 连接。
     */
    async wsTicket(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();
      if (user.blocked === true || user.confirmed === false) return ctx.unauthorized();

      const ticket = await issueTicket(user.id);
      if (!ticket) {
        ctx.status = 503;
        ctx.body = { error: { status: 503, name: 'ServiceUnavailable', message: 'failed to issue ticket' } };
        return;
      }

      ctx.send({ data: { ticket, ttlSec: 30 } });
    },
  }),
);
