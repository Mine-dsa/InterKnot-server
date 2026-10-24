import type { LifecycleEvent } from '../../../../types/strapi';
import { extractRelationId } from '../../../../utils/common';

export default {
  async beforeCreate(event: LifecycleEvent) {
    await validateFavoriteWrite(event);
  },
  async beforeUpdate(event: LifecycleEvent) {
    await validateFavoriteWrite(event);
  },
  async afterCreate(event: LifecycleEvent) {
    await notifyOnFavorite(event);
    await addFavoriteExp(event);
  },
};

const extractDocumentId = (value: any): string | null => {
  if (!value) return null;
  if (typeof value?.documentId === 'string' && value.documentId.trim()) {
    return value.documentId.trim();
  }

  const connect = Array.isArray(value?.connect) ? value.connect[0] : null;
  if (typeof connect?.documentId === 'string' && connect.documentId.trim()) {
    return connect.documentId.trim();
  }

  return null;
};

const loadFavoriteWithRelations = async (where: any) => {
  return strapi.db.query('api::favorite.favorite').findOne({
    where,
    populate: {
      user: true,
      article: {
        populate: {
          author: {
            populate: { user: true },
          },
        },
      },
    },
  });
};

const resolveArticleId = async (value: any, fallbackId: number | null) => {
  const relationId = extractRelationId(value);
  if (relationId) return relationId;

  const documentId = extractDocumentId(value);
  if (documentId) {
    const article = await strapi.db.query('api::article.article').findOne({
      where: { documentId },
      select: ['id'],
    });
    if (article?.id) return article.id;
  }

  return fallbackId;
};

async function validateFavoriteWrite(event: LifecycleEvent) {
  const data = event?.params?.data || {};
  const where = event?.params?.where || {};

  const existingFavorite = where?.id || where?.documentId
    ? await loadFavoriteWithRelations(where?.id ? { id: where.id } : { documentId: where.documentId })
    : null;

  const userId = extractRelationId(data.user) || existingFavorite?.user?.id || null;
  const articleId = await resolveArticleId(data.article, existingFavorite?.article?.id || null);

  if (!userId) {
    throw new Error('Favorite user is required');
  }

  if (!articleId) {
    throw new Error('Favorite article is required');
  }

  const duplicate = await strapi.db.query('api::favorite.favorite').findOne({
    where: {
      user: { id: userId },
      article: { id: articleId },
    },
    select: ['id'],
  });

  if (duplicate?.id && duplicate.id !== existingFavorite?.id) {
    throw new Error('Already favorited');
  }
}

async function notifyOnFavorite(event: LifecycleEvent) {
  const { result } = event;

  const favorite: any = await loadFavoriteWithRelations({ id: result.id });

  // 匿名帖被收藏不发通知
  if (favorite?.article?.isAnonymous) return;

  const senderId = favorite.user?.id;
  const recipientId = favorite.article?.author?.user?.id;

  if (!senderId || !recipientId) return;

  if (recipientId === senderId) return;

  await strapi.db.query("api::notification.notification").create({
    data: {
      type: "favorite",
      recipient: recipientId,
      sender: senderId,
      Article: favorite.article?.id,
      isRead: false,
    },
  });
}

async function addFavoriteExp(event: LifecycleEvent) {
  const { result } = event;
  try {
    const favorite: any = await loadFavoriteWithRelations({ id: result.id });
    const recipientId = favorite?.article?.author?.user?.id;
    if (!recipientId || favorite?.user?.id === recipientId) return;

    const { addExp } = require('../../../../utils/level');

    // 统一走 addExp：经验日志审计 + 按 relatedId 去重 + 日上限（互动收益 1000/日），
    // 与点赞/评论的经验体系保持一致。
    await addExp(strapi, recipientId, 2, 'favorite_received', 'api::favorite.favorite', favorite.id);
  } catch (err) {
    strapi.log.error('Error adding exp for favorite:', err);
  }
}
