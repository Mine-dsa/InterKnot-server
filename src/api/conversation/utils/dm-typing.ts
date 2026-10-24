import type { Core } from '@strapi/strapi';
/**
 * DM「正在输入」广播：供 WS 客户端上行与 Agent internal 共用。
 */
import { publishToUser } from './ws-bus';
import { listActiveMembers } from './dm-helpers';

const nowIso = () => new Date().toISOString();

/**
 * 向会话内其它成员推送 typing（不含 sender 本人）。
 * @param conversationDocumentId 会话 documentId
 * @param senderUserId 正在输入的用户 id（如 fairy）
 */
export const publishDmTyping = async (
  strapi: Core.Strapi,
  conversationDocumentId: string,
  senderUserId: number,
): Promise<void> => {
  if (!conversationDocumentId || !Number.isInteger(senderUserId)) return;

  const conv: any = await strapi.db.query('api::conversation.conversation').findOne({
    where: { documentId: conversationDocumentId },
    select: ['id', 'documentId'],
  });
  if (!conv) return;

  const members = await listActiveMembers(strapi, conv.id);
  const senderInConv = members.some((m) => m?.user?.id === senderUserId);
  if (!senderInConv) return;

  const recipients = members
    .map((m) => m.user?.id)
    .filter((id): id is number => Number.isInteger(id) && id !== senderUserId);

  const at = nowIso();
  for (const rid of recipients) {
    publishToUser(rid, {
      type: 'typing',
      conversationId: conv.documentId,
      data: { userId: senderUserId },
      at,
    });
  }
};
