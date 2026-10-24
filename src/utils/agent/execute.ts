import type { Core } from '@strapi/strapi';
import { stripMentionsToPlain } from '../../api/comment/utils/mention';
import { invalidateDmListCache, listActiveMembers } from '../../api/conversation/utils/dm-helpers';
import { publishToUsers } from '../../api/conversation/utils/ws-bus';
import { buildSenderResolver, serializeMessage } from '../../api/message/utils/serialize';
import { prependMentionToBody } from './mention-token';

import { findLastDmResetAt } from './dm-reset';
import { findRoleCardByBoundUserId } from './resolve';
import {
  extractSiteSearchQuery,
  formatSearchResults,
  searchArticlesForAgent,
} from './site-search';
import { resolveCommentAgentTargetUserId, resolveGroupMentionedAiUserId } from './triggers';

const COMMENT_UID = 'api::comment.comment';

async function assertReplyAiUserId(
  strapi: Core.Strapi,
  kind: 'comment' | 'dm',
  triggerId: number,
  aiUserId: number,
): Promise<void> {
  const expected =
    kind === 'comment'
      ? await resolveCommentAgentTargetUserId(strapi, triggerId)
      : await resolveDmAgentTargetUserId(strapi, triggerId);
  if (!Number.isInteger(expected) || expected !== aiUserId) {
    throw new Error('aiUserId mismatch for trigger');
  }
}

async function resolveAiAuthor(strapi: Core.Strapi, aiUserId: number) {
  const author = await strapi.db.query('api::author.author').findOne({
    where: { user: { id: aiUserId } },
    populate: { user: { select: ['id', 'username', 'isAiAgent'] } },
  });
  if (!author?.id) throw new Error('AI author not found');
  return author;
}

export async function executeCommentReply(
  strapi: Core.Strapi,
  opts: { triggerCommentId: number; body: string; aiUserId: number },
) {
  const { triggerCommentId, body, aiUserId } = opts;
  await assertReplyAiUserId(strapi, 'comment', triggerCommentId, aiUserId);
  const trigger: any = await strapi.db.query(COMMENT_UID).findOne({
    where: { id: triggerCommentId },
    populate: {
      author: { select: ['documentId', 'name'], populate: { user: true } },
      article: { select: ['id', 'documentId', 'isAnonymous'] },
      parent: { select: ['isAnonymous'] },
    },
  });
  if (!trigger) throw new Error('trigger comment not found');
  if (trigger.isAnonymous || trigger.article?.isAnonymous || trigger.parent?.isAnonymous) {
    throw new Error('anonymous context');
  }

  const card = await findRoleCardByBoundUserId(strapi, aiUserId);
  if (!card || card.commentEnabled === false) throw new Error('comment disabled');

  const aiAuthor = await resolveAiAuthor(strapi, aiUserId);
  const triggerAuthor = trigger.author;
  if (!triggerAuthor?.documentId) throw new Error('trigger author missing');

  const displayName =
    triggerAuthor.name || triggerAuthor.user?.username || '用户';
  const content = prependMentionToBody(displayName, triggerAuthor.documentId, body);

  const created: any = await (strapi.documents)(COMMENT_UID).create({
    data: {
      article: trigger.article.id,
      author: aiAuthor.id,
      parent: trigger.id,
      content,
      isAnonymous: false,
    },
  });

  return { commentId: created?.id, documentId: created?.documentId };
}

export async function executeDmReply(
  strapi: Core.Strapi,
  opts: { triggerMessageId: number; body: string; aiUserId: number },
) {
  const { triggerMessageId, body, aiUserId } = opts;
  await assertReplyAiUserId(strapi, 'dm', triggerMessageId, aiUserId);

  const trigger: any = await strapi.db.query('api::message.message').findOne({
    where: { id: triggerMessageId },
    select: ['id', 'kind'],
    populate: {
      conversation: { select: ['id', 'documentId', 'kind'] },
      sender: { select: ['id'] },
    },
  });
  if (!trigger || trigger.kind !== 'text') throw new Error('invalid trigger message');

  const convId = trigger.conversation?.id;
  const convDocumentId = trigger.conversation?.documentId;
  if (!Number.isInteger(convId) || !convDocumentId) {
    throw new Error('conversation missing on trigger message');
  }

  const card = await findRoleCardByBoundUserId(strapi, aiUserId);
  if (!card || card.dmEnabled === false) throw new Error('dm disabled');

  const members = await listActiveMembers(strapi, convId);
  const peer = members.find((m: any) => m?.user?.id === aiUserId);
  if (!peer) throw new Error('AI not in conversation');

  const content = (body || '').trim();
  if (!content) throw new Error('empty body');

  const created: any = await (strapi.documents)('api::message.message').create({
    data: {
      conversation: convId,
      sender: aiUserId,
      content,
      kind: 'text',
    },
  });

  await strapi.db.query('api::conversation.conversation').update({
    where: { id: convId },
    data: {
      lastMessage: created.id,
      lastMessageAt: created.createdAt,
    },
  });

  const memberUserIds = members
    .map((m: any) => m.user?.id)
    .filter((id: unknown): id is number => Number.isInteger(id));
  await invalidateDmListCache(memberUserIds);

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
  const senderMap = await buildSenderResolver(strapi, [aiUserId]);
  const serialized = serializeMessage(detail, senderMap);

  publishToUsers(memberUserIds, {
    type: 'message.created',
    conversationId: convDocumentId,
    messageId: detail.documentId,
    data: { message: serialized },
    at: detail.createdAt,
  });

  return { messageId: created.id, documentId: created.documentId };
}

export async function buildCommentLlmContext(strapi: Core.Strapi, commentId: number) {
  const comment: any = await strapi.db.query(COMMENT_UID).findOne({
    where: { id: commentId },
    populate: {
      author: { select: ['name', 'documentId'], populate: { user: { select: ['id', 'username'] } } },
      article: { select: ['documentId', 'title', 'text', 'isAnonymous'] },
      parent: {
        select: ['content'],
        populate: { author: { select: ['name'] } },
      },
    },
  });
  if (!comment) return null;

  const articleText = comment.article?.text || '';
  const userComment = stripMentionsToPlain(comment.content || '');
  const parentSnippet = comment.parent
    ? stripMentionsToPlain(comment.parent.content || '').slice(0, 500)
    : '';

  return {
    quotaUserId: comment.author?.user?.id ?? null,
    articleDocumentId: comment.article?.documentId || '',
    articleTitle: comment.article?.title || '',
    articleBody: String(articleText).slice(0, 4000),
    userName: comment.author?.name || comment.author?.user?.username || '用户',
    userComment,
    parentSnippet,
  };
}

export async function resolveDmAgentTargetUserId(
  strapi: Core.Strapi,
  messageId: number,
): Promise<number | null> {
  const msg: any = await strapi.db.query('api::message.message').findOne({
    where: { id: messageId },
    populate: {
      sender: { select: ['id'] },
      conversation: { select: ['id', 'kind'] },
    },
  });
  if (!msg || msg.kind !== 'text') return null;
  const convKind = msg.conversation?.kind;
  if (convKind !== 'direct' && convKind !== 'group') return null;
  const senderId = msg.sender?.id;
  if (!Number.isInteger(senderId)) return null;

  const members = await listActiveMembers(strapi, msg.conversation.id);

  if (convKind === 'group') {
    // 群聊（3.3.5）：回复对象为消息里被 @提及 的 AI 成员。
    return resolveGroupMentionedAiUserId(strapi, msg.content || '', members, senderId);
  }

  const peer = members.find((m: any) => m?.user?.id && m.user.id !== senderId);
  const peerUserId = peer?.user?.id;
  if (!Number.isInteger(peerUserId)) return null;

  const card = await findRoleCardByBoundUserId(strapi, peerUserId);
  if (!card || card.dmEnabled === false) return null;
  return peerUserId;
}

export async function buildDmLlmContext(strapi: Core.Strapi, messageId: number) {
  const msg: any = await strapi.db.query('api::message.message').findOne({
    where: { id: messageId },
    populate: {
      sender: { select: ['id', 'username'] },
      conversation: { select: ['id'] },
    },
  });
  if (!msg?.conversation?.id) return null;

  const aiUserId = await resolveDmAgentTargetUserId(strapi, messageId);

  // 对话重置（3.3.4）：只取最近一次 reset 标记之后的消息，实现「清空记忆开新话题」。
  const resetAt = await findLastDmResetAt(strapi, msg.conversation.id);

  const rows = await strapi.db.query('api::message.message').findMany({
    where: {
      conversation: { id: msg.conversation.id },
      deletedAt: { $null: true },
      kind: 'text',
      ...(resetAt ? { createdAt: { $gt: resetAt } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }],
    // 多拉一些历史，交由 worker 端按 token 预算从新到旧裁剪。
    limit: 40,
    populate: { sender: { select: ['id', 'username'] } },
  });

  const lines = (rows || [])
    .reverse()
    .map((m) => {
      const isAi = aiUserId != null && m.sender?.id === aiUserId;
      const who = isAi ? 'assistant' : m.sender?.username || '用户';
      return `${who}: ${m.content || ''}`;
    });

  const latestUserMessage = msg.content || '';

  // 站内搜帖闭环：检测「找帖」意图后执行真实搜索，结果交给 prompt 层引用。
  let siteSearchQuery: string | null = null;
  let siteSearchResults: string | null = null;
  try {
    const q = extractSiteSearchQuery(latestUserMessage);
    if (q) {
      const hits = await searchArticlesForAgent(strapi, q, 5);
      siteSearchQuery = q;
      siteSearchResults = formatSearchResults(hits);
    }
  } catch (err) {
    strapi.log?.warn?.('[agent] site search failed', err);
  }

  return {
    quotaUserId: msg.sender?.id ?? null,
    recentMessages: lines.join('\n'),
    latestUserMessage,
    siteSearchQuery,
    siteSearchResults,
  };
}
