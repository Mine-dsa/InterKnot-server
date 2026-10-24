import type { Core } from '@strapi/strapi';
/**
 * Notification 序列化辅助：把 entityService 返回的 raw 通知转成前端 NotificationDto，
 * 同时在 type=like 且 sender 实际收藏过 article 的情况下回退为 favorite 显示。
 *
 * 抽出来给 list / listMessages 共用，避免两份序列化逻辑漂移。
 */
import { batchResolveEquippedAvatars, withSmallWebp } from '../../../utils/common';
import { buildAnonymousName } from '../../../utils/anonymous';

/** 从 Strapi media（多图）关系中取第一张封面的宽高比 */
const extractCoverAspectRatio = (cover: unknown): number | null => {
  const first = Array.isArray(cover) ? cover[0] : cover;
  const w = first?.width;
  const h = first?.height;
  if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
    return w / h;
  }
  return null;
};

export interface SerializedNotification {
  documentId: string;
  type: string;
  rawType: string;
  isRead: boolean;
  createdAt: string;
  sender: unknown;
  article: { documentId: string; title: string; coverAspectRatio: number | null } | null;
  comment: { documentId: string; content: string; isAnonymous: boolean } | null;
}

/**
 * 将一批 raw 通知序列化为前端 DTO。
 * - 自动 batch resolve 装备的头像
 * - 自动检测 like→favorite 升级（sender 真的有 favorite 记录）
 * - 自动对匿名评论的 sender 隐去身份
 */
export const serializeNotifications = async (
  strapi: Core.Strapi,
  rows: Record<string, unknown>[],
): Promise<SerializedNotification[]> => {
  if (!rows?.length) return [];

  const senderUserIds = [
    ...new Set(
      rows
        .map((item: any) => item?.sender?.id)
        .filter((id: unknown): id is number => typeof id === 'number'),
    ),
  ];
  const senderAvatarMap = await batchResolveEquippedAvatars(strapi, senderUserIds);

  // 历史 like 通知里部分其实是 favorite，按 favorite 表实际存在与否做升级
  const legacyFavoriteCandidates = rows.filter(
    (item: any) =>
      item?.type === 'like' &&
      !!item?.Article?.id &&
      !item?.Comment?.id &&
      Number.isInteger(item?.sender?.id),
  );

  let favoritePairSet = new Set<string>();
  if (legacyFavoriteCandidates.length > 0) {
    const candidateSenderIds = Array.from(
      new Set(legacyFavoriteCandidates.map((i: any) => i.sender.id as number)),
    );
    const candidateArticleIds = Array.from(
      new Set(legacyFavoriteCandidates.map((i: any) => i.Article.id as number)),
    );

    if (candidateSenderIds.length && candidateArticleIds.length) {
      const favorites = await strapi.db.query('api::favorite.favorite').findMany({
        where: {
          user: { id: { $in: candidateSenderIds } },
          article: { id: { $in: candidateArticleIds } },
        },
        select: ['id'],
        populate: {
          user: { select: ['id'] },
          article: { select: ['id'] },
        },
      });

      favoritePairSet = new Set(
        (favorites || [])
          .map((fav: any) => {
            const sId = fav?.user?.id;
            const aId = fav?.article?.id;
            if (!Number.isInteger(sId) || !Number.isInteger(aId)) return '';
            return `${sId}:${aId}`;
          })
          .filter((key: string) => !!key),
      );
    }
  }

  return rows.map((item: any) => {
    const linkedComment = item?.Comment;
    const isAnonymousComment = !!linkedComment?.isAnonymous;
    const anonymousName = isAnonymousComment
      ? buildAnonymousName(linkedComment?.anonymousSeed)
      : null;

    const sender = item?.sender;
    const anonEquippedAvatar = isAnonymousComment && Number.isInteger(sender?.id) && senderAvatarMap.has(sender.id)
      ? (withSmallWebp(senderAvatarMap.get(sender.id)) ?? null)
      : null;

    const renderedSender = sender
      ? isAnonymousComment
        ? {
            id: null,
            username: anonymousName,
            level: null,
            author: {
              documentId: null,
              name: anonymousName,
              avatar: anonEquippedAvatar,
            },
          }
        : {
            id: sender.id,
            username: sender.username,
            level: sender.level ?? null,
            author: sender.author
              ? {
                  documentId: sender.author.documentId,
                  name: sender.author.name,
                  avatar: senderAvatarMap.has(sender.id)
                    ? withSmallWebp(senderAvatarMap.get(sender.id))
                    : (sender.author.avatar ?? null),
                }
              : null,
          }
      : null;

    const upgradedType =
      item?.type === 'like' &&
      item?.Article?.id &&
      !item?.Comment?.id &&
      favoritePairSet.has(`${item?.sender?.id}:${item?.Article?.id}`)
        ? 'favorite'
        : item?.type;

    return {
      documentId: item?.documentId,
      type: upgradedType,
      rawType: item?.type,
      isRead: !!item?.isRead,
      createdAt: item?.createdAt,
      sender: renderedSender,
      article: item?.Article
        ? {
            documentId: item.Article.documentId,
            title: item.Article.title,
            coverAspectRatio: extractCoverAspectRatio(item.Article.cover),
          }
        : item?.Comment?.article
          ? {
              documentId: item.Comment.article.documentId,
              title: item.Comment.article.title,
              coverAspectRatio: extractCoverAspectRatio(item.Comment.article.cover),
            }
          : null,
      comment: linkedComment
        ? {
            documentId: linkedComment.documentId,
            content: linkedComment.content,
            isAnonymous: isAnonymousComment,
          }
        : null,
    };
  });
};
