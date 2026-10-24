import type { Core } from '@strapi/strapi';
import { collectMentionedDocumentIds } from '../../api/comment/utils/mention';
import {
  collectAiAuthorDocumentIds,
  findRoleCardByBoundUserId,
  loadGlobalAgentConfig,
} from './resolve';
import { listActiveMembers } from '../../api/conversation/utils/dm-helpers';
import { enqueueAgentJob } from './queue';


export async function isAiUserId(strapi: Core.Strapi, userId: number | null | undefined): Promise<boolean> {
  if (!Number.isInteger(userId)) return false;
  const user = await strapi.db.query('plugin::users-permissions.user').findOne({
    where: { id: userId },
    select: ['id', 'isAiAgent'],
  });
  return user?.isAiAgent === true;
}

/**
 * 群聊（3.3.5）：在群成员里找出「被 @提及」的、启用了 DM 的 AI 用户，返回其 userId。
 * 消息正文为纯文本，按 `@用户名` / `@角色名` 子串匹配（大小写不敏感）。无匹配返回 null。
 * 多个 AI 被提及时返回第一个命中者。
 */
export async function resolveGroupMentionedAiUserId(
  strapi: Core.Strapi,
  content: string,
  members: Array<{ user?: { id?: number } | null }>,
  senderId: number,
): Promise<number | null> {
  const text = String(content || '').toLowerCase();
  if (!text.includes('@')) return null;

  const candidateIds = members
    .map((m) => m?.user?.id)
    .filter((id): id is number => Number.isInteger(id) && id !== senderId);
  if (candidateIds.length === 0) return null;

  const users = await strapi.db.query('plugin::users-permissions.user').findMany({
    where: { id: { $in: candidateIds }, isAiAgent: true },
    select: ['id', 'username'],
    populate: { author: { select: ['name'] } },
  });
  if (!Array.isArray(users) || users.length === 0) return null;

  for (const u of users) {
    const names = [u?.username, u?.author?.name]
      .map((n) => String(n || '').trim().toLowerCase())
      .filter(Boolean);
    const mentioned = names.some((n) => text.includes(`@${n}`));
    if (!mentioned) continue;
    const card = await findRoleCardByBoundUserId(strapi, u.id);
    if (card && card.dmEnabled !== false) return u.id;
  }
  return null;
}

/** 评论触发判定所需的 relation populate 形态。 */
const COMMENT_AGENT_POPULATE = {
  author: { populate: { user: { select: ['id'] } } },
  article: {
    select: ['isAnonymous'],
    populate: { author: { populate: { user: { select: ['id', 'isAiAgent'] } } } },
  },
  parent: {
    select: ['isAnonymous'],
    populate: { author: { populate: { user: { select: ['id', 'isAiAgent'] } } } },
  },
} as const;

/**
 * 读取刚创建的评论用于 AI 触发判定，行不存在时做有限次退避重试。
 *
 * afterCreate 通过 `setImmediate` 异步进入本链路，而这里的查询走的是连接池里
 * 另一条连接，可能赶在该评论的 create 事务对此连接可见之前执行，使 findOne
 * 返回 null（读写竞态）。此时若直接判空返回，被 @ 的 AI 本该回复的评论就被
 * 静默丢弃、不入队——表现为「有时 @AI 不回复」。因此对「查不到」这一种情况
 * 退避重试，覆盖提交可见性的短暂延迟；查到后照常走后续判定逻辑（普通评论自然
 * 在首次即命中，不产生额外延迟）。
 */
async function loadCommentForAgentTrigger(
  strapi: Core.Strapi,
  commentId: number,
): Promise<any | null> {
  const delaysMs = [0, 50, 100, 200, 400, 800];
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
    const comment = await strapi.db.query('api::comment.comment').findOne({
      where: { id: commentId },
      populate: COMMENT_AGENT_POPULATE as any,
    });
    if (comment) return comment;
  }
  return null;
}

/** 解析应由哪一位 AI 用户回复该评论；无则 null */
export async function resolveCommentAgentTargetUserId(
  strapi: Core.Strapi,
  commentId: number,
): Promise<number | null> {
  const comment: any = await loadCommentForAgentTrigger(strapi, commentId);
  if (!comment) {
    // 重试后仍查不到：要么评论真被删了，要么提交可见性延迟超出重试窗口。
    // 记一条 warn 便于排查「AI 漏回复」，不再静默吞掉。
    strapi.log?.warn?.(
      `[agent] resolveCommentAgentTargetUserId: comment ${commentId} not found (post-create visibility race?)`,
    );
    return null;
  }
  if (comment.isAnonymous || comment.article?.isAnonymous) return null;
  if (comment.parent?.isAnonymous) return null;
  if (await isAiUserId(strapi, comment.author?.user?.id)) return null;

  const aiAuthorDocIds = await collectAiAuthorDocumentIds(strapi);
  const mentioned = collectMentionedDocumentIds(comment.content || '', 10);
  const aiMentions = mentioned.filter((docId) => aiAuthorDocIds.has(docId));
  if (aiMentions.length > 0) {
    const authors = await strapi.db.query('api::author.author').findMany({
      where: { documentId: { $in: aiMentions } },
      populate: { user: { select: ['id'] } },
    });
    for (const docId of aiMentions) {
      const author = authors.find((a) => a?.documentId === docId);
      if (author?.user?.id) return author.user.id;
    }
  }
  if (comment.parent?.author?.user?.id && (await isAiUserId(strapi, comment.parent.author.user.id))) {
    return comment.parent.author.user.id;
  }
  if (
    comment.article?.author?.user?.id &&
    (await isAiUserId(strapi, comment.article.author.user.id))
  ) {
    return comment.article.author.user.id;
  }
  return null;
}

/**
 * 评论创建后：判断是否应由 AI 回复并入队。
 * 匿名帖/匿名评论不触发。
 */
export async function maybeEnqueueCommentAgentJob(strapi: Core.Strapi, commentId: number) {
  try {
    const globalCfg = await loadGlobalAgentConfig(strapi);
    if (globalCfg?.globalEnabled === false) return;

    const targetUserId = await resolveCommentAgentTargetUserId(strapi, commentId);
    if (!targetUserId) return;

    const card = await findRoleCardByBoundUserId(strapi, targetUserId);
    if (!card || card.commentEnabled === false) return;

    await enqueueAgentJob(strapi, { type: 'comment', commentId });
  } catch (err) {
    strapi.log?.warn?.('[agent] maybeEnqueueCommentAgentJob failed', err);
  }
}

export type DmAgentEnqueueHints = {
  senderUserId?: number;
  conversationId?: number;
};

/**
 * DM 文本消息创建后入队（发送方非 AI，对端为启用 AI 角色）。
 * hints：控制器在 lifecycle 之后传入，避免 relation 尚未写入导致误判。
 */
export async function maybeEnqueueDmAgentJob(
  strapi: Core.Strapi,
  messageId: number,
  hints?: DmAgentEnqueueHints,
) {
  try {
    const globalCfg = await loadGlobalAgentConfig(strapi);
    if (globalCfg?.globalEnabled === false) return;

    const msg: any = await strapi.db.query('api::message.message').findOne({
      where: { id: messageId },
      select: ['id', 'kind', 'content'],
      populate: {
        sender: { select: ['id'] },
        conversation: { select: ['id', 'kind'] },
      },
    });
    if (!msg || msg.kind !== 'text') return;
    if (!msg.content?.trim()) return;

    const senderId = Number.isInteger(hints?.senderUserId)
      ? hints!.senderUserId
      : msg.sender?.id;
    if (!Number.isInteger(senderId)) return;
    if (await isAiUserId(strapi, senderId)) return;

    const conversationId = Number.isInteger(hints?.conversationId)
      ? hints!.conversationId
      : msg.conversation?.id;
    if (!Number.isInteger(conversationId)) return;

    let convKind = msg.conversation?.kind;
    if (!convKind) {
      const conv = await strapi.db.query('api::conversation.conversation').findOne({
        where: { id: conversationId },
        select: ['kind'],
      });
      convKind = conv?.kind;
    }

    const members = await listActiveMembers(strapi, conversationId);

    if (convKind === 'direct') {
      const peer = members.find((m: any) => m?.user?.id && m.user.id !== senderId);
      const peerUserId = peer?.user?.id;
      if (!Number.isInteger(peerUserId)) return;
      if (!(await isAiUserId(strapi, peerUserId))) return;

      const card = await findRoleCardByBoundUserId(strapi, peerUserId);
      if (!card || card.dmEnabled === false) return;
    } else if (convKind === 'group') {
      // 群聊（3.3.5）：只有当某 AI 成员被 @提及 时才触发回复，避免 AI 在群里抢话。
      const target = await resolveGroupMentionedAiUserId(
        strapi,
        msg.content || '',
        members,
        senderId,
      );
      if (!Number.isInteger(target)) return;
    } else {
      return;
    }

    await enqueueAgentJob(strapi, { type: 'dm', messageId });
  } catch (err) {
    strapi.log?.warn?.('[agent] maybeEnqueueDmAgentJob failed', err);
  }
}
