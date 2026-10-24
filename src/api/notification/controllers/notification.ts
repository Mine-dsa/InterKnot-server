/**
 * notification controller
 *
 * 路由：
 *  GET    /notifications/list                       —— 兼容旧接口（分页 raw 通知）
 *  GET    /notifications/unread-count               —— 全局未读计数
 *  PUT    /notifications/:id/mark-read              —— 单条已读
 *  PUT    /notifications/mark-all-read              —— 全部已读
 *
 *  GET    /knock/conversations                      —— 敲敲会话列表（聚合）
 *  GET    /knock/conversations/:id/messages         —— 单会话消息流（cursor 分页）
 *  POST   /knock/conversations/:id/mark-read        —— 单会话批量已读
 *  GET    /knock/stream                             —— SSE 实时推送
 */

import { factories } from '@strapi/strapi';
import { parsePagination, withSmallWebp, batchResolveEquippedAvatars } from '../../../utils/common';
import { buildAnonymousName } from '../../../utils/anonymous';
import { getRedis } from '../../../utils/redis';
import { stripMentionsToPlain } from '../../comment/utils/mention';
import { serializeNotifications } from '../utils/serialize';
import {
  buildConversationWhere,
  classifyNotification,
  decodeConversationId,
  encodeConversationId,
  KnockCategory,
  matchesConversation,
  SYSTEM_PEER_KEY,
} from '../utils/conversation';
import { publish, subscribe } from '../utils/sse-bus';
import { issueSseTicket, verifySseTicket } from '../utils/sse-ticket';
import { invalidateDmListCache } from '../../conversation/utils/dm-helpers';

/** 单次会话聚合扫描的硬上限。超过这个数量需要换 SQL group-by 实现。 */
const CONVERSATION_AGGREGATE_CAP = 5000;

/** 单会话消息分页默认/最大值 */
const MESSAGES_DEFAULT_LIMIT = 50;
const MESSAGES_MAX_LIMIT = 100;

/** SSE 心跳间隔 */
const SSE_HEARTBEAT_MS = 25_000;

/** listConversations 结果 Redis 缓存 TTL（秒） */
const CONV_CACHE_TTL_SEC = 30;

/** ─────────────────────────────────────────────────────────
 * listConversations Redis 缓存
 * 设计取舍：
 * - TTL 短（30s），即便忘了 invalidate 也只会脏一小段时间
 * - 任何写入路径都主动 DEL，常规情况下用户操作后立刻看到最新值
 * - Redis 不可用时所有函数静默返回 null/false，主流程继续走 DB 直查
 * ───────────────────────────────────────────────────────── */
const knockConvCacheKey = (userId: number) => `knock:conv:${userId}`;

const getCachedConvList = async (
  userId: number,
): Promise<unknown | null> => {
  try {
    const redis = getRedis();
    const raw = await redis.get(knockConvCacheKey(userId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const setCachedConvList = async (
  userId: number,
  payload: unknown,
): Promise<void> => {
  try {
    const redis = getRedis();
    await redis.set(
      knockConvCacheKey(userId),
      JSON.stringify(payload),
      'EX',
      CONV_CACHE_TTL_SEC,
    );
  } catch {
    /* noop */
  }
};

const invalidateConvCache = async (userId: number): Promise<void> => {
  try {
    const redis = getRedis();
    await redis.del(knockConvCacheKey(userId));
  } catch {
    /* noop */
  }
};

interface ConversationSummary {
  id: string;
  category: KnockCategory;
  peerKey: string;
  peerName: string;
  peerAvatar: string | null;
  unread: number;
  lastAt: string;
  lastPreview: string;
  lastType: string;
}

const previewOf = (item: any): string => {
  // 交互类要先于 Comment.content 判定：因为 like-on-comment 的 notification.Comment
  // 是被点赞的评论（收件人自己写的内容），不能当作 sender 的发言展示。
  //
  // 判定用 item?.Comment 整对象 truthy（Strapi 关系为空时 populate 返回 null），
  // 与前端 bubbleText/fallbackBubbleText 的 `item.comment` 口径一致，
  // 避免「后端按 Comment.id、前端按 comment 对象」两套等价但条件不同的判定再次漂移。
  if (item?.type === 'like') {
    return item?.Comment ? '赞了你的评论' : '赞了你的帖子';
  }
  if (item?.type === 'favorite') return '收藏了你的帖子';
  if (item?.type === 'denny') return '给你的帖子投了币';
  // 评论正文里的 @[name](id) token 在会话预览里转成 @name，更易读
  if (item?.Comment?.content) return stripMentionsToPlain(item.Comment.content);
  if (item?.type === 'system') return '系统消息';
  return '';
};

const derivePeerInfo = (
  category: KnockCategory,
  peerKey: string,
  item: any,
  senderAvatarMap: Map<number, any>,
): { name: string; avatar: string | null } => {
  if (category === 'anonymous') {
    const senderId = item?.sender?.id;
    let anonAvatar: string | null = null;
    if (Number.isInteger(senderId) && senderAvatarMap.has(senderId)) {
      anonAvatar = withSmallWebp(senderAvatarMap.get(senderId))?.url ?? null;
    }
    return { name: buildAnonymousName(peerKey), avatar: anonAvatar };
  }
  if (peerKey === SYSTEM_PEER_KEY) {
    return { name: '系统消息', avatar: null };
  }

  const sender = item?.sender;
  const author = sender?.author;
  const name = author?.name || sender?.username || '未知用户';
  let avatarUrl: string | null = null;
  if (Number.isInteger(sender?.id) && senderAvatarMap.has(sender.id)) {
    const equipped = withSmallWebp(senderAvatarMap.get(sender.id));
    avatarUrl = equipped?.url ?? null;
  } else if (author?.avatar?.url) {
    avatarUrl = author.avatar.url;
  }
  return { name, avatar: avatarUrl };
};

/** SSE 写入的小工具：把事件按 SSE 协议格式化输出 */
const writeSseEvent = (
  res: any,
  eventName: string,
  payload: unknown,
): void => {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
};

/** cursor: base64url(`${createdAtIso}|${documentId}`) */
const encodeCursor = (createdAt: string, documentId: string): string =>
  Buffer.from(`${createdAt}|${documentId}`, 'utf8').toString('base64url');

const decodeCursor = (raw: unknown): { iso: string; docId: string } | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    return { iso: decoded.slice(0, sep), docId: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
};

export default factories.createCoreController(
  'api::notification.notification',
  ({ strapi }) => ({
    async list(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) {
        ctx.send({
          data: [],
          meta: {
            pagination: { start: 0, limit: 0, total: 0, pageCount: 0 },
          },
        });
        return;
      }

      const startRaw = ctx.query?.start;
      const limitRaw = ctx.query?.limit;
      const isReadRaw = ctx.query?.isRead;

      const { start: safeStart, limit: safeLimit } = parsePagination(startRaw, limitRaw);

      const where: any = { recipient: { id: user.id } };
      if (isReadRaw === 'true') where.isRead = true;
      if (isReadRaw === 'false') where.isRead = false;

      const [data, total] = await Promise.all([
        // db.query 而不是 entityService.findMany —— Comment.anonymousSeed 是 private 字段
        strapi.db.query('api::notification.notification').findMany({
          offset: safeStart,
          limit: safeLimit,
          orderBy: { createdAt: 'desc' },
          where,
          select: ['id', 'documentId', 'type', 'isRead', 'createdAt'],
          populate: {
            sender: {
              select: ['id', 'username', 'level'],
              populate: {
                author: {
                  select: ['documentId', 'name'],
                  populate: { avatar: { select: ['url', 'width', 'height'] } },
                },
              },
            },
            Article: {
              select: ['id', 'documentId', 'title'],
              populate: { cover: { select: ['width', 'height'] } },
            },
            Comment: {
              select: ['id', 'documentId', 'content', 'isAnonymous', 'anonymousSeed'],
              populate: {
                article: {
                  select: ['documentId', 'title'],
                  populate: { cover: { select: ['width', 'height'] } },
                },
              },
            },
          },
        }),
        strapi.db.query('api::notification.notification').count({ where }),
      ]);

      const list = await serializeNotifications(strapi, data || []);

      ctx.send({
        data: list,
        meta: {
          pagination: {
            start: safeStart,
            limit: safeLimit,
            total,
            pageCount: safeLimit > 0 ? Math.ceil(total / safeLimit) : 0,
          },
        },
      });
    },

    async unreadCount(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) {
        ctx.send({ count: 0 });
        return;
      }

      const count = await strapi.db.query('api::notification.notification').count({
        where: { recipient: { id: user.id }, isRead: false },
      });

      ctx.send({ count });
    },

    async markAsRead(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const rawId = typeof ctx.params?.id === 'string' ? ctx.params.id.trim() : '';
      if (!rawId) return ctx.badRequest('Missing notification id');

      const isNumericId = /^\d+$/.test(rawId);
      const where: any = {
        recipient: { id: user.id },
        ...(isNumericId
          ? { id: Number.parseInt(rawId, 10) }
          : { documentId: rawId }),
      };

      const notification = await strapi.db.query('api::notification.notification').findOne({
        where,
        select: ['id', 'documentId'],
      });

      if (!notification) return ctx.notFound('Notification not found');

      await strapi.db.query('api::notification.notification').update({
        where: { id: notification.id },
        data: { isRead: true },
      });

      void invalidateConvCache(user.id);
      void invalidateDmListCache([user.id]);

      publish(user.id, {
        type: 'notification.read',
        notificationId: notification.documentId,
        at: new Date().toISOString(),
      });

      ctx.send({ success: true, documentId: notification.documentId });
    },

    async markAllAsRead(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      // Strapi db.query.updateMany 不支持嵌套关联表的 where 条件，
      // 需要先 findMany 取 id 列表，再按 id 批量更新。
      const candidates = await strapi.db.query('api::notification.notification').findMany({
        where: { recipient: { id: user.id }, isRead: false },
        select: ['id'],
        limit: 5000,
      });
      const ids = candidates.map((r) => r.id).filter((id) => Number.isInteger(id));

      let count = 0;
      if (ids.length > 0) {
        const result = await strapi.db.query('api::notification.notification').updateMany({
          where: { id: { $in: ids } },
          data: { isRead: true },
        });
        count = (result)?.count ?? ids.length;
      }

      void invalidateConvCache(user.id);
      void invalidateDmListCache([user.id]);

      publish(user.id, {
        type: 'notification.read.bulk',
        count,
        at: new Date().toISOString(),
      });

      ctx.send({ success: true, updated: count });
    },

    /**
     * 敲敲会话列表
     * 一次最多扫 CONVERSATION_AGGREGATE_CAP 条 raw 通知，按 (category, peerKey) 在内存里分组。
     * 99% 用户在该上限内；若 truncated=true，前端可提示用户清理或后续切到 SQL group-by。
     */
    async listConversations(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) {
        ctx.send({ data: [], meta: { total: 0, truncated: false } });
        return;
      }

      // Cache hit：直接返回。任何 mutation 都会主动 invalidate，
      // 加上 TTL 30s 兜底，最坏情况脏读 30s。
      const cached = await getCachedConvList(user.id);
      if (cached) {
        ctx.send(cached);
        return;
      }

      // 注意：用 db.query 而不是 entityService.findMany —— Comment.anonymousSeed
      // 在 schema 里是 `private: true`，entityService 的 fields 校验会拒掉这个 key。
      // db.query 直接走 ORM，没有这层 sanitize。
      const rows = await strapi.db
        .query('api::notification.notification')
        .findMany({
          where: { recipient: { id: user.id } },
          orderBy: { createdAt: 'desc' },
          limit: CONVERSATION_AGGREGATE_CAP,
          select: ['id', 'documentId', 'type', 'isRead', 'createdAt'],
          populate: {
            sender: {
              select: ['id', 'username'],
              populate: {
                author: {
                  select: ['documentId', 'name'],
                  populate: { avatar: { select: ['url'] } },
                },
              },
            },
            Comment: { select: ['content', 'isAnonymous', 'anonymousSeed'] },
          },
        });

      const senderIds = [
        ...new Set(
          rows
            .map((i: any) => i?.sender?.id)
            .filter((id: unknown): id is number => Number.isInteger(id)),
        ),
      ];
      const senderAvatarMap = await batchResolveEquippedAvatars(strapi, senderIds);

      const buckets = new Map<string, ConversationSummary>();
      for (const item of rows) {
        const decoded = classifyNotification({
          type: item?.type,
          sender: item?.sender ?? null,
          Comment: item?.Comment ?? null,
        });
        if (!decoded) continue;

        const id = encodeConversationId(decoded.category, decoded.peerKey);
        let bucket = buckets.get(id);
        if (!bucket) {
          const peer = derivePeerInfo(decoded.category, decoded.peerKey, item, senderAvatarMap);
          bucket = {
            id,
            category: decoded.category,
            peerKey: decoded.peerKey,
            peerName: peer.name,
            peerAvatar: peer.avatar,
            unread: 0,
            lastAt: item.createdAt,
            lastPreview: previewOf(item),
            lastType: item.type,
          };
          buckets.set(id, bucket);
        }
        if (!item.isRead) bucket.unread += 1;
        if (item.createdAt && item.createdAt > bucket.lastAt) {
          bucket.lastAt = item.createdAt;
          bucket.lastPreview = previewOf(item);
          bucket.lastType = item.type;
        }
      }

      const list = Array.from(buckets.values()).sort((a, b) =>
        a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0,
      );

      const payload = {
        data: list,
        meta: {
          total: list.length,
          truncated: rows.length >= CONVERSATION_AGGREGATE_CAP,
          scannedRows: rows.length,
          cap: CONVERSATION_AGGREGATE_CAP,
        },
      };

      // 写缓存与 send 串行：避免用户立即触发 mutation（如 mark-read）时
      // DEL 覆盖掉未完成的 SET，导致缓存里存入陈旧数据（竞态窗口通常 < 5ms）。
      await setCachedConvList(user.id, payload);
      ctx.send(payload);
    },

    /**
     * 单会话消息流（cursor 分页，按 createdAt DESC）
     * 返回数据按 createdAt ASC 排序，方便前端直接 append。
     */
    async listMessages(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const decoded = decodeConversationId(ctx.params?.id);
      if (!decoded) return ctx.badRequest('Invalid conversation id');

      const limitRaw = Number.parseInt(String(ctx.query?.limit ?? ''), 10);
      const safeLimit = Math.max(
        1,
        Math.min(
          Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : MESSAGES_DEFAULT_LIMIT,
          MESSAGES_MAX_LIMIT,
        ),
      );

      const cursor = decodeCursor(ctx.query?.cursor);
      const convWhere = buildConversationWhere(user.id, decoded);

      const filters = cursor
        ? {
            $and: [
              convWhere,
              {
                $or: [
                  { createdAt: { $lt: cursor.iso } },
                  { createdAt: cursor.iso, documentId: { $lt: cursor.docId } },
                ],
              },
            ],
          }
        : convWhere;

      // 同样用 db.query 绕过 anonymousSeed 的 private 字段校验。
      // 多取一些行（safeLimit * 3）做缓冲，因为接下来会在 JS 侧用 matchesConversation
      // 二次过滤掉不属于该会话的记录（例如 contacts 桶里混进来的匿名评论）。
      const fetchLimit = safeLimit * 3 + 1;
      const rows = await strapi.db
        .query('api::notification.notification')
        .findMany({
          where: filters,
          // tie-breaker 必须与游标比较字段一致（decodeCursor 用 documentId），
          // 否则同一秒批量插入的通知在翻页时可能漏行/重复。
          orderBy: [{ createdAt: 'desc' }, { documentId: 'desc' }],
          limit: fetchLimit,
          select: ['id', 'documentId', 'type', 'isRead', 'createdAt'],
          populate: {
            sender: {
              select: ['id', 'username', 'level'],
              populate: {
                author: {
                  select: ['documentId', 'name'],
                  populate: { avatar: { select: ['url', 'width', 'height'] } },
                },
              },
            },
            Article: {
              select: ['id', 'documentId', 'title'],
              populate: { cover: { select: ['width', 'height'] } },
            },
            Comment: {
              select: ['id', 'documentId', 'content', 'isAnonymous', 'anonymousSeed'],
              populate: {
                article: {
                  select: ['documentId', 'title'],
                  populate: { cover: { select: ['width', 'height'] } },
                },
              },
            },
          },
        });

      // JS 侧二次过滤，确保和 listConversations 的分类完全一致
      const matched = rows.filter((r) =>
        matchesConversation(
          {
            type: r?.type,
            sender: r?.sender ?? null,
            Comment: r?.Comment ?? null,
          },
          decoded,
        ),
      );

      const hasMore = matched.length > safeLimit || rows.length >= fetchLimit;
      const slice = matched.slice(0, safeLimit);

      const serialized = await serializeNotifications(strapi, slice);

      // 前端期望按时间升序展示
      serialized.reverse();

      const tail = slice[slice.length - 1];
      const nextCursor =
        hasMore && tail
          ? encodeCursor(tail.createdAt, tail.documentId)
          : null;

      ctx.send({
        data: serialized,
        meta: { nextCursor, hasMore },
      });
    },

    /**
     * 把单会话内所有未读 notification 一次性置为 isRead=true。
     * 替代之前前端逐条 PUT mark-read 的做法。
     */
    async markConversationRead(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const decoded = decodeConversationId(ctx.params?.id);
      if (!decoded) return ctx.badRequest('Invalid conversation id');

      const baseWhere = {
        ...buildConversationWhere(user.id, decoded),
        isRead: false,
      };

      // 先查 id 列表（带 sender/Comment 用于 JS 二次过滤），再按 id 更新。
      // 这样和 listMessages 用同一套分类逻辑，避免误标。
      const candidates = await strapi.db
        .query('api::notification.notification')
        .findMany({
          where: baseWhere,
          select: ['id', 'type'],
          populate: {
            sender: { select: ['id'] },
            Comment: { select: ['isAnonymous', 'anonymousSeed'] },
          },
          // 单会话未读量天然不大，但极端情况（多年累积 / 滥用）下可能上万。
          // 用聚合扫描的同一个上限作为护栏，超出部分由用户下次操作再增量处理。
          // 注意：Strapi v5 db.query 不支持 limit:-1 「无限」约定，会被解释为 0。
          limit: CONVERSATION_AGGREGATE_CAP,
          orderBy: { createdAt: 'desc' },
        });

      const targetIds = candidates
        .filter((r) =>
          matchesConversation(
            {
              type: r?.type,
              sender: r?.sender ?? null,
              Comment: r?.Comment ?? null,
            },
            decoded,
          ),
        )
        .map((r) => r.id)
        .filter((id) => Number.isInteger(id));

      let count = 0;
      if (targetIds.length > 0) {
        const result = (await strapi.db
          .query('api::notification.notification')
          .updateMany({
            where: { id: { $in: targetIds } },
            data: { isRead: true },
          })) as { count?: number } | undefined;
        count = result?.count ?? 0;
        void invalidateConvCache(user.id);
        void invalidateDmListCache([user.id]);
      }

      // 仅在实际更新了通知时才推送 SSE，避免无意义的刷新
      if (count > 0) {
        publish(user.id, {
          type: 'notification.read.bulk',
          conversationId: encodeConversationId(decoded.category, decoded.peerKey),
          count,
          at: new Date().toISOString(),
        });
      }

      ctx.send({ success: true, updated: count });
    },

    /**
     * POST /api/knock/stream-ticket
     * 为 EventSource 签发一次性 SSE ticket（替代原 ?token=<jwt> 直连——JWT 走
     * URL query 会被代理/日志/浏览器历史泄漏）。
     */
    async sseTicket(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const ticket = await issueSseTicket(user.id);
      if (!ticket) {
        strapi.log.warn('[knock-sse] ticket issue failed (redis unavailable?)');
        return ctx.serviceUnavailable('SSE ticket unavailable, please retry later');
      }

      ctx.send({ ticket, expiresIn: 30 });
    },

    /**
     * SSE 长连接：订阅当前用户的实时通知事件。
     *
     * 鉴权（与 DM WebSocket 同范式）：优先 Authorization Bearer 头；
     * EventSource 无法传头时使用 ?ticket=<一次性票据>（POST /api/knock/stream-ticket
     * 签发，30s 内一次性消费）。不再支持 ?token=<jwt>（防泄漏）。
     * 路由配置 auth:false，由本方法手动验证。
     */
    async stream(ctx) {
      let user: any = ctx.state?.user;
      if (!user?.id) {
        const authHeader = ctx.request?.header?.authorization;
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
          const token = authHeader.slice(7).trim();
          if (!token) return ctx.unauthorized();
          try {
            const jwtService = strapi.plugin('users-permissions').service('jwt');
            const payload = await jwtService.verify(token);
            if (!payload?.id) return ctx.unauthorized();
            user = await strapi.db
              .query('plugin::users-permissions.user')
              .findOne({ where: { id: payload.id } });
            if (!user) return ctx.unauthorized();
          } catch {
            return ctx.unauthorized();
          }
        } else {
          // EventSource：一次性 ticket 验证（GETDEL，不可复用）
          const ticket = typeof ctx.query?.ticket === 'string' ? ctx.query.ticket.trim() : '';
          if (!ticket) return ctx.unauthorized();
          const ticketUserId = await verifySseTicket(ticket);
          if (!ticketUserId) return ctx.unauthorized();
          user = await strapi.db
            .query('plugin::users-permissions.user')
            .findOne({ where: { id: ticketUserId } });
          if (!user) return ctx.unauthorized();
        }
      }

      // 显式拒绝被封禁 / 未激活账号。
      // Strapi 默认的 auth pipeline 会做这件事，但我们走的是 ?token= 手动 JWT 验证 +
      // 直接 db.query 取 user，绕过了 users-permissions 的 middleware，必须自己补。
      if (user?.blocked === true || user?.confirmed === false) {
        return ctx.unauthorized();
      }

      ctx.respond = false;
      const res = ctx.res;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx 会默认缓冲 SSE，要关掉
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      writeSseEvent(res, 'hello', { at: new Date().toISOString() });

      const heartbeat = setInterval(() => {
        try {
          res.write(`:hb ${Date.now()}\n\n`);
        } catch {
          // 写入失败说明连接已断，由下面 close 兜底
        }
      }, SSE_HEARTBEAT_MS);

      // subscribe 返回的 unsubscribe 与 cleanup 是相互引用关系：
      // cleanup 里要调 unsubscribe，subscribe 的 onEvict 又要调 cleanup。
      // 先把 unsubscribe 声明成 let null，避免 TDZ。
      let unsubscribe: (() => void) | null = null;
      let cleanupCalled = false;
      const cleanup = () => {
        if (cleanupCalled) return;
        cleanupCalled = true;
        clearInterval(heartbeat);
        unsubscribe?.();
        try {
          // 给客户端一个明确的关闭事件，便于前端区分「自然结束」和「网络中断」
          writeSseEvent(res, 'bye', { at: new Date().toISOString() });
        } catch {
          /* noop */
        }
        try {
          res.end();
        } catch {
          /* noop */
        }
      };

      unsubscribe = subscribe(
        user.id,
        (event) => {
          try {
            writeSseEvent(res, event.type, event);
          } catch (err) {
            strapi.log?.warn?.('[knock-sse] write failed', err as Error);
          }
        },
        // 被 SSE bus 因为超过单用户连接上限而踢出时，主动关闭这条 HTTP 连接，
        // 否则 res 一直挂着，socket 不释放。
        () => cleanup(),
      );

      ctx.req.on('close', cleanup);
      ctx.req.on('error', cleanup);
    },
  }),
);
