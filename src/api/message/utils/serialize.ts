import type { Core } from '@strapi/strapi';
import { withSmallWebp, batchResolveEquippedAvatars } from '../../../utils/common';

export interface SerializedSender {
  userId: number | null;
  authorDocumentId: string | null;
  name: string;
  avatar: string | null;
  level: number | null;
  isAiAgent?: boolean;
}

export const buildSenderResolver = async (
  strapi: Core.Strapi,
  userIds: number[],
): Promise<Map<number, SerializedSender>> => {
  const out = new Map<number, SerializedSender>();
  if (userIds.length === 0) return out;
  const uniqueIds = Array.from(new Set(userIds));
  const authors = await strapi.db.query('api::author.author').findMany({
    where: { user: { id: { $in: uniqueIds } } },
    select: ['documentId', 'name'],
    populate: {
      avatar: { select: ['url', 'width', 'height'] },
      user: { select: ['id', 'username', 'level', 'isAiAgent'] },
    },
  });
  const avatarMap = await batchResolveEquippedAvatars(strapi, uniqueIds);
  for (const a of authors || []) {
    const uid = a?.user?.id;
    if (!Number.isInteger(uid)) continue;
    const equipped = avatarMap.get(uid);
    const avatar = equipped
      ? withSmallWebp(equipped)
      : a?.avatar
        ? withSmallWebp(a.avatar)
        : null;
    out.set(uid, {
      userId: uid,
      authorDocumentId: a?.documentId ?? null,
      name: a?.name || a?.user?.username || '未知用户',
      avatar: avatar?.url ?? null,
      level: a?.user?.level ?? null,
      isAiAgent: a?.user?.isAiAgent === true,
    });
  }
  return out;
};

export const serializeMessage = (msg: any, senderMap: Map<number, SerializedSender>): any => {
  const senderUserId = msg?.sender?.id ?? null;
  const sender = senderUserId != null ? senderMap.get(senderUserId) ?? null : null;
  const isDeleted = !!msg?.deletedAt;
  return {
    documentId: msg?.documentId,
    kind: msg?.kind,
    content: isDeleted ? null : (msg?.content ?? null),
    createdAt: msg?.createdAt,
    editedAt: msg?.editedAt ?? null,
    deletedAt: msg?.deletedAt ?? null,
    sender,
    replyTo: msg?.replyTo
      ? {
          documentId: msg.replyTo.documentId,
          content: msg.replyTo.deletedAt ? null : (msg.replyTo.content?.slice(0, 80) ?? null),
          senderUserId: msg.replyTo.sender?.id ?? null,
        }
      : null,
  };
};
