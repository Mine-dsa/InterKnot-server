import type { Core } from '@strapi/strapi';
import { invalidateDmListCache, listActiveMembers } from '../../api/conversation/utils/dm-helpers';
import { publishToUsers } from '../../api/conversation/utils/ws-bus';
import { buildSenderResolver, serializeMessage } from '../../api/message/utils/serialize';
import { resolveDmAgentTargetUserId } from './execute';

const MESSAGE_UID = 'api::message.message';

async function loadMessageDetail(strapi: Core.Strapi, id: number, aiUserId: number) {
  const detail: any = await strapi.db.query(MESSAGE_UID).findOne({
    where: { id },
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
  return { detail, serialized: serializeMessage(detail, senderMap) };
}

async function resolveConvAndMembers(strapi: Core.Strapi, placeholderDocumentId: string) {
  const placeholder: any = await strapi.db.query(MESSAGE_UID).findOne({
    where: { documentId: placeholderDocumentId },
    select: ['id', 'documentId', 'content'],
    populate: { conversation: { select: ['id', 'documentId'] }, sender: { select: ['id'] } },
  });
  if (!placeholder) throw new Error('placeholder message not found');
  const convId = placeholder.conversation?.id;
  const convDocumentId = placeholder.conversation?.documentId;
  if (!Number.isInteger(convId) || !convDocumentId) throw new Error('conversation missing');
  const members = await listActiveMembers(strapi, convId);
  const memberUserIds = members
    .map((m: any) => m.user?.id)
    .filter((id: unknown): id is number => Number.isInteger(id));
  return { placeholder, convId, convDocumentId, memberUserIds };
}

/**
 * 流式回复（3.2.3）：创建空占位 AI 消息，广播 message.created（content=''），
 * 前端据此渲染一个空的 AI 气泡，随后由 delta 增量填充。
 */
export async function startDmStreamMessage(
  strapi: Core.Strapi,
  triggerMessageId: number,
  aiUserId: number,
): Promise<{ id: number; documentId: string }> {
  const resolved = await resolveDmAgentTargetUserId(strapi, triggerMessageId);
  if (!Number.isInteger(resolved) || resolved !== aiUserId) {
    throw new Error('aiUserId mismatch for trigger message');
  }

  const trigger: any = await strapi.db.query(MESSAGE_UID).findOne({
    where: { id: triggerMessageId },
    select: ['id', 'kind'],
    populate: { conversation: { select: ['id', 'documentId'] } },
  });
  if (!trigger || trigger.kind !== 'text') throw new Error('invalid trigger message');
  const convId = trigger.conversation?.id;
  const convDocumentId = trigger.conversation?.documentId;
  if (!Number.isInteger(convId) || !convDocumentId) throw new Error('conversation missing');

  const created: any = await (strapi.documents)(MESSAGE_UID).create({
    data: { conversation: convId, sender: aiUserId, content: '', kind: 'text' },
  });

  await strapi.db.query('api::conversation.conversation').update({
    where: { id: convId },
    data: { lastMessage: created.id, lastMessageAt: created.createdAt },
  });

  const members = await listActiveMembers(strapi, convId);
  const memberUserIds = members
    .map((m: any) => m.user?.id)
    .filter((id: unknown): id is number => Number.isInteger(id));
  await invalidateDmListCache(memberUserIds);

  const { detail, serialized } = await loadMessageDetail(strapi, created.id, aiUserId);
  publishToUsers(memberUserIds, {
    type: 'message.created',
    conversationId: convDocumentId,
    messageId: detail.documentId,
    data: { message: serialized, streaming: true },
    at: detail.createdAt,
  });

  return { id: created.id, documentId: created.documentId };
}

/** 流式回复：广播累计文本增量（message.delta），不落库（减少写放大）。 */
export async function pushDmStreamDelta(
  strapi: Core.Strapi,
  placeholderDocumentId: string,
  acc: string,
): Promise<void> {
  const { convDocumentId, memberUserIds } = await resolveConvAndMembers(
    strapi,
    placeholderDocumentId,
  );
  publishToUsers(memberUserIds, {
    type: 'message.delta',
    conversationId: convDocumentId,
    messageId: placeholderDocumentId,
    data: { content: acc },
    at: new Date().toISOString(),
  });
}

/** 流式回复：用最终（已清洗）文本定稿占位消息并广播 message.edited。 */
export async function finishDmStreamMessage(
  strapi: Core.Strapi,
  placeholderDocumentId: string,
  body: string,
): Promise<{ documentId: string }> {
  const content = (body || '').trim();
  if (!content) throw new Error('empty body');

  const { placeholder, convDocumentId, memberUserIds } = await resolveConvAndMembers(
    strapi,
    placeholderDocumentId,
  );
  const aiUserId = placeholder.sender?.id;

  await (strapi.documents)(MESSAGE_UID).update({
    documentId: placeholderDocumentId,
    data: { content },
  });
  await invalidateDmListCache(memberUserIds);

  const { detail, serialized } = await loadMessageDetail(strapi, placeholder.id, aiUserId);
  // 与普通编辑（message.ts）保持同一 payload 形状：data.content / data.editedAt，
  // 否则前端 onMessageEdited 读到的 data.content 为 undefined，会把定稿内容清空成空气泡。
  // 额外保留 message / streamingDone 供需要完整对象的客户端使用。
  publishToUsers(memberUserIds, {
    type: 'message.edited',
    conversationId: convDocumentId,
    messageId: detail.documentId,
    data: {
      content: serialized.content ?? content,
      editedAt: detail.editedAt || detail.createdAt,
      message: serialized,
      streamingDone: true,
    },
    at: detail.editedAt || detail.createdAt,
  });

  return { documentId: placeholder.documentId };
}
