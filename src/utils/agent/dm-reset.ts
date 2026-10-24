import type { Core } from '@strapi/strapi';

/**
 * 对话重置标记（3.3.4）。写入一条 kind:'system' 消息作为「上下文分界线」，
 * buildDmLlmContext 只取最后一条该标记之后的消息，从而清空 AI 记忆但保留聊天记录。
 */
export const DM_RESET_MARKER = '[对话已重置]';

/**
 * 查询某会话最近一次 reset 标记的时间。无标记返回 null。
 */
export async function findLastDmResetAt(
  strapi: Core.Strapi,
  conversationId: number,
): Promise<Date | null> {
  const row: any = await strapi.db.query('api::message.message').findOne({
    where: {
      conversation: { id: conversationId },
      kind: 'system',
      content: DM_RESET_MARKER,
      deletedAt: { $null: true },
    },
    select: ['id', 'createdAt'],
    orderBy: [{ createdAt: 'desc' }],
  });
  if (!row?.createdAt) return null;
  const at = new Date(row.createdAt);
  return Number.isNaN(at.getTime()) ? null : at;
}
