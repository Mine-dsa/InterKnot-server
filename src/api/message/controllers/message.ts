/**
 * message controller —— DM 消息相关 API。
 *
 * 路由：
 *   GET    /api/dm/conversations/:id/messages   list      历史消息 cursor 分页
 *   POST   /api/dm/conversations/:id/messages   send      发送消息
 *   PATCH  /api/dm/messages/:id                 edit      编辑（5min 内）
 *   DELETE /api/dm/messages/:id                 withdraw  撤回（5min 内，软删）
 *
 * 写入路径会同步更新 conversation.lastMessage / lastMessageAt，并通过
 * ws-bus 广播事件给会话内其它在线成员。
 */
import { factories } from '@strapi/strapi';
import {
  findActiveMember,
  listActiveMembers,
  invalidateDmListCache,
  checkAndRecordSendRate,
  DM_CONTENT_MAX,
  DM_EDIT_WINDOW_MS,
  DM_WITHDRAW_WINDOW_MS,
} from '../../conversation/utils/dm-helpers';
import {
  decodePseudoConvId,
  fetchNotificationsForUser,
  isPseudoConvId,
  notificationToDmMessage,
  mergeDmMessagesWithNotifications,
} from '../../conversation/utils/notification-merge';
import { serializeNotifications } from '../../notification/utils/serialize';
import { publishToUsers } from '../../conversation/utils/ws-bus';
import { buildSenderResolver, serializeMessage } from '../utils/serialize';
import { maybeEnqueueDmAgentJob } from '../../../utils/agent/triggers';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const nowIso = () => new Date().toISOString();

export default factories.createCoreController(
  'api::message.message',
  ({ strapi }) => ({
    /**
     * GET /api/dm/conversations/:id/messages?before=<cursor>&limit=50
     * cursor 是 base64url(`${createdAtIso}|${documentId}`)；省略则取最新一页。
     * 倒序返回（新的在前），客户端展示时再 reverse。
     */
    async list(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('conversation id required');

      const limitRaw = Number.parseInt(String(ctx.query?.limit ?? ''), 10);
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT, MAX_LIMIT));

      // ── 分支 1：pseudo 会话（仅通知，没有 DM message） ──────────
      // pseudo:user:N / pseudo:anonymous:seed / pseudo:system 都走这里：
      // 一次性拉对应通知（5000 上限），不分页（量级足够小，hasMore 永远 false）。
      // 用户若需要发消息，前端会先调 /api/dm/conversations/direct 把会话实质化
      // 后再切到真 documentId，不会再来访问 pseudo id 的 messages 端点。
      if (isPseudoConvId(docId)) {
        const decoded = decodePseudoConvId(docId);
        if (!decoded) return ctx.badRequest('invalid pseudo conversation id');

        const notifRows = await fetchNotificationsForUser(strapi, user.id, {
          senderUserId: decoded.kind === 'user' ? Number.parseInt(decoded.key, 10) : undefined,
          anonymousSeed: decoded.kind === 'anonymous' ? decoded.key : undefined,
          systemOnly: decoded.kind === 'system',
        });

        // notifRows 已是 createdAt desc，与 DM message.list 的返回顺序对齐
        // （前端 useDmConversations.toAsc 会做最终反转得到 asc）。
        const serialized = await serializeNotifications(strapi, notifRows);
        const messages = serialized.map(notificationToDmMessage);
        ctx.send({ data: messages, meta: { hasMore: false, nextCursor: null } });
        return;
      }

      // ── 分支 2：真 DM 会话 ─────────────────────────────────
      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'kind'],
      });
      if (!conv) return ctx.notFound();

      const myMember = await findActiveMember(strapi, conv.id, user.id);
      if (!myMember) return ctx.forbidden('not a member');

      const beforeRaw = ctx.query?.before;
      let beforeCursor: { iso: string; docId: string } | null = null;
      if (typeof beforeRaw === 'string' && beforeRaw) {
        try {
          const decoded = Buffer.from(beforeRaw, 'base64url').toString('utf8');
          const sep = decoded.indexOf('|');
          if (sep > 0) {
            beforeCursor = { iso: decoded.slice(0, sep), docId: decoded.slice(sep + 1) };
          }
        } catch {
          /* 忽略坏 cursor */
        }
      }

      const where: any = { conversation: { id: conv.id } };
      if (beforeCursor) {
        // 严格 < cursor：按 createdAt desc, documentId desc 复合排序
        where.$or = [
          { createdAt: { $lt: beforeCursor.iso } },
          {
            $and: [
              { createdAt: { $eq: beforeCursor.iso } },
              { documentId: { $lt: beforeCursor.docId } },
            ],
          },
        ];
      }

      const rows = await strapi.db.query('api::message.message').findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { documentId: 'desc' }],
        limit: limit + 1, // 多取一条判断 hasMore
        select: ['id', 'documentId', 'content', 'createdAt', 'editedAt', 'deletedAt', 'kind'],
        populate: {
          sender: { select: ['id'] },
          replyTo: {
            select: ['documentId', 'content', 'deletedAt'],
            populate: { sender: { select: ['id'] } },
          },
        },
      });

      const hasMore = rows.length > limit;
      const sliced = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && sliced.length > 0
          ? Buffer.from(`${sliced[sliced.length - 1].createdAt}|${sliced[sliced.length - 1].documentId}`, 'utf8').toString('base64url')
          : null;

      // 序列化 sender
      const senderUserIds = sliced
        .map((r) => r?.sender?.id)
        .filter((id): id is number => Number.isInteger(id));
      const senderMap = await buildSenderResolver(strapi, senderUserIds);

      // 与原 M2 契约一致：返回 createdAt desc，前端 toAsc 时反转得到 asc。
      // 通知合并也按 desc 排序，避免与 DM 顺序对调导致前端展示倒置。
      const dmDesc = sliced.map((m) => serializeMessage(m, senderMap));

      // 仅在「首页」且为 direct 会话时合并 peer 给 self 的通知
      // - 翻历史（带 cursor）时不再追加通知，避免每翻一页都 dump 整个通知集合
      // - 群聊（kind=group）暂不融合通知（语义上也不对齐）
      let outMessages = dmDesc;
      if (!beforeCursor && conv.kind === 'direct') {
        try {
          const otherMembers = await listActiveMembers(strapi, conv.id);
          const peer = (otherMembers || []).find((m) => m?.user?.id !== user.id);
          const peerUserId = peer?.user?.id;
          if (Number.isInteger(peerUserId)) {
            const notifRows = await fetchNotificationsForUser(strapi, user.id, {
              senderUserId: peerUserId,
            });
            if (notifRows.length) {
              outMessages = await mergeDmMessagesWithNotifications(strapi, dmDesc, notifRows);
            }
          }
        } catch (err) {
          strapi.log?.warn?.('[message.list] notification merge failed', err);
        }
      }

      ctx.send({
        data: outMessages,
        meta: { hasMore, nextCursor },
      });
    },

    /**
     * POST /api/dm/conversations/:id/messages
     * body: { content?: string, kind?: 'text'|'image', replyTo?: documentId }
     */
    async send(ctx) {
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

      // 限流
      const rateCheck = await checkAndRecordSendRate(user.id);
      if (rateCheck.blocked) {
        ctx.status = 429;
        ctx.body = {
          error: {
            status: 429,
            name: 'TooManyRequests',
            message: '发送过于频繁，请稍后再试',
            details: { retryAfterSec: rateCheck.retryAfterSec ?? 1 },
          },
        };
        return;
      }

      const body = (ctx.request?.body)?.data || ctx.request?.body || {};
      const kind = typeof body.kind === 'string' && ['text', 'image'].includes(body.kind) ? body.kind : 'text';
      const contentRaw = typeof body.content === 'string' ? body.content : '';
      const content = contentRaw.trim();

      if (kind === 'text' && !content) {
        return ctx.badRequest('content required for text message');
      }
      if (content.length > DM_CONTENT_MAX) {
        return ctx.badRequest(`content too long (max ${DM_CONTENT_MAX})`);
      }

      // 可选：replyTo 必须是同一会话内未撤回的消息
      let replyToId: number | null = null;
      const replyToDocId = typeof body.replyTo === 'string' ? body.replyTo.trim() : '';
      if (replyToDocId) {
        const replyToMsg: any = await strapi.db.query('api::message.message').findOne({
          where: { documentId: replyToDocId },
          select: ['id', 'deletedAt'],
          populate: { conversation: { select: ['id'] } },
        });
        if (!replyToMsg) return ctx.badRequest('replyTo not found');
        if (replyToMsg.conversation?.id !== conv.id) {
          return ctx.badRequest('replyTo not in this conversation');
        }
        if (replyToMsg.deletedAt) return ctx.badRequest('replyTo has been withdrawn');
        replyToId = replyToMsg.id;
      }

      // 写入消息（走 documents API 触发 lifecycle）
      // cast：新 content-type UID 在 IDE 类型联合首次生成前不被识别，
      // 启动后重生成 types 即消失（与其它三个 service 文件同理）。
      const created: any = await (strapi.documents)('api::message.message').create({
        data: {
          conversation: conv.id,
          sender: user.id,
          content,
          kind,
          ...(replyToId ? { replyTo: replyToId } : {}),
        },
      });

      const createdMessageId = created?.id;
      if (kind === 'text' && Number.isInteger(createdMessageId)) {
        setImmediate(() => {
          maybeEnqueueDmAgentJob(strapi, createdMessageId, {
            senderUserId: user.id,
            conversationId: conv.id,
          }).catch(() => {});
        });
      }

      // 更新 conversation lastMessage / lastMessageAt
      await strapi.db.query('api::conversation.conversation').update({
        where: { id: conv.id },
        data: {
          lastMessage: created.id,
          lastMessageAt: created.createdAt,
        },
      });

      // 取所有活跃成员（推送 + 列表缓存 invalidate）
      const members = await listActiveMembers(strapi, conv.id);
      const memberUserIds = members
        .map((m) => m.user?.id)
        .filter((id): id is number => Number.isInteger(id));

      await invalidateDmListCache(memberUserIds);

      // 序列化 + 推送
      const senderMap = await buildSenderResolver(strapi, [user.id]);
      // 重新查 created 带 sender / replyTo populate（lifecycle 之后 documents.create 不一定带）
      const detail: any = await strapi.db.query('api::message.message').findOne({
        where: { id: created.id },
        select: ['id', 'documentId', 'content', 'createdAt', 'editedAt', 'deletedAt', 'kind'],
        populate: {
          sender: { select: ['id'] },
          replyTo: {
            select: ['documentId', 'content', 'deletedAt'],
            populate: { sender: { select: ['id'] } },
          },
        },
      });
      const serialized = serializeMessage(detail, senderMap);

      // 推 message.created 给所有在线成员（含 sender 自己——多端同步）
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
     * PATCH /api/dm/messages/:id
     * body: { content }
     * 仅 sender 本人，5 分钟内。撤回过的不能再编辑。
     */
    async edit(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('message id required');

      const msg: any = await strapi.db.query('api::message.message').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'content', 'createdAt', 'kind', 'deletedAt'],
        populate: {
          conversation: { select: ['id', 'documentId'] },
          sender: { select: ['id'] },
        },
      });
      if (!msg) return ctx.notFound();
      if (msg.sender?.id !== user.id) return ctx.forbidden('not your message');
      if (msg.deletedAt) return ctx.badRequest('message has been withdrawn');
      if (msg.kind !== 'text') return ctx.badRequest('only text message can be edited');

      const ageMs = Date.now() - new Date(msg.createdAt).getTime();
      if (ageMs > DM_EDIT_WINDOW_MS) return ctx.badRequest('edit window expired');

      const body = (ctx.request?.body)?.data || ctx.request?.body || {};
      const newContent = typeof body.content === 'string' ? body.content.trim() : '';
      if (!newContent) return ctx.badRequest('content required');
      if (newContent.length > DM_CONTENT_MAX) return ctx.badRequest('content too long');
      if (newContent === msg.content) return ctx.send({ data: { ok: true } }); // 无变化

      const editedAt = nowIso();
      await strapi.db.query('api::message.message').update({
        where: { id: msg.id },
        data: { content: newContent, editedAt },
      });

      const members = await listActiveMembers(strapi, msg.conversation.id);
      const memberUserIds = members
        .map((m) => m.user?.id)
        .filter((id): id is number => Number.isInteger(id));

      publishToUsers(memberUserIds, {
        type: 'message.edited',
        conversationId: msg.conversation.documentId,
        messageId: msg.documentId,
        data: { content: newContent, editedAt },
        at: editedAt,
      });

      // 不需要 invalidate 列表缓存：lastMessage 引用关系没变，但内容会被
      // 下一次 list 重新读到。如果该消息恰好是 lastMessage，列表预览会有
      // 至多 30s 滞后——可接受。
      ctx.send({ data: { documentId: msg.documentId, content: newContent, editedAt } });
    },

    /**
     * DELETE /api/dm/messages/:id
     * 撤回（软删）。仅 sender 本人，5 分钟内。
     */
    async withdraw(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const docId = String(ctx.params?.id || '').trim();
      if (!docId) return ctx.badRequest('message id required');

      const msg: any = await strapi.db.query('api::message.message').findOne({
        where: { documentId: docId },
        select: ['id', 'documentId', 'createdAt', 'deletedAt'],
        populate: {
          conversation: { select: ['id', 'documentId'] },
          sender: { select: ['id'] },
        },
      });
      if (!msg) return ctx.notFound();
      if (msg.sender?.id !== user.id) return ctx.forbidden('not your message');
      if (msg.deletedAt) return ctx.send({ data: { ok: true } }); // 幂等

      const ageMs = Date.now() - new Date(msg.createdAt).getTime();
      if (ageMs > DM_WITHDRAW_WINDOW_MS) return ctx.badRequest('withdraw window expired');

      const deletedAt = nowIso();
      await strapi.db.query('api::message.message').update({
        where: { id: msg.id },
        data: { deletedAt },
      });

      const members = await listActiveMembers(strapi, msg.conversation.id);
      const memberUserIds = members
        .map((m) => m.user?.id)
        .filter((id): id is number => Number.isInteger(id));

      // 列表预览可能是这条消息——主动失效缓存
      await invalidateDmListCache(memberUserIds);

      publishToUsers(memberUserIds, {
        type: 'message.deleted',
        conversationId: msg.conversation.documentId,
        messageId: msg.documentId,
        data: { deletedAt },
        at: deletedAt,
      });

      ctx.send({ data: { documentId: msg.documentId, deletedAt } });
    },
  }),
);
