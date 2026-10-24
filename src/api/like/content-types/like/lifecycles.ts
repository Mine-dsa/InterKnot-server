import type { LifecycleEvent } from '../../../../types/strapi';
import { extractRelationId } from '../../../../utils/common';

export default {
  async beforeCreate(event: LifecycleEvent) {
    await validateLikeCreate(event);
  },
  async afterCreate(event: LifecycleEvent) {
    await handleLikeCreated(event);
  },
  async beforeDelete(event: LifecycleEvent) {
    await cacheLikeBeforeDelete(event);
  },
  async afterDelete(event: LifecycleEvent) {
    await handleLikeDeleted(event);
  },
};

export const loadLikeWithRelations = async (where: any) => {
  return strapi.db.query('api::like.like').findOne({
    where,
    populate: {
      user: true,
      article: {
        populate: {
          author: {
            populate: {
              user: true,
            },
          },
        },
      },
      comment: {
        populate: {
          author: {
            populate: {
              user: true,
            },
          },
        },
      },
    },
  });
};

async function validateLikeCreate(event: LifecycleEvent) {
  const data = event?.params?.data || {};

  const userId = extractRelationId(data.user);
  const articleId = extractRelationId(data.article);
  const commentId = extractRelationId(data.comment);

  const hasArticle = !!articleId;
  const hasComment = !!commentId;

  if (!userId) {
    throw new Error('Like user is required');
  }

  if (hasArticle === hasComment) {
    throw new Error('Like target must be either article or comment');
  }

  const where: any = {
    user: { id: userId },
  };

  if (articleId) where.article = { id: articleId };
  if (commentId) where.comment = { id: commentId };

  const existing = await strapi.db.query('api::like.like').findOne({
    where,
    select: ['id'],
  });

  if (existing?.id) {
    throw new Error('Already liked');
  }
}

async function cacheLikeBeforeDelete(event: LifecycleEvent) {
  const where = event?.params?.where || {};
  const state = event.state || (event.state = {});

  if (where?.id) {
    state.likeBeforeDelete = await loadLikeWithRelations({ id: where.id });
    return;
  }

  if (where?.documentId) {
    state.likeBeforeDelete = await loadLikeWithRelations({ documentId: where.documentId });
    return;
  }

  // 兜底：当 where 不是 id/documentId 时，尝试用原始条件查找
  if (Object.keys(where).length > 0) {
    state.likeBeforeDelete = await loadLikeWithRelations(where);
  }
}

// afterCreate/afterDelete 中的副作用互相独立、均为尽力而为：like 行此时已提交，
// 单个副作用（计数/通知/经验）失败不应让请求 500，也不应连累其它副作用。
async function runSideEffects(
  label: string,
  tasks: Array<readonly [string, Promise<unknown>]>,
) {
  const results = await Promise.allSettled(tasks.map(([, p]) => p));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      strapi.log.error(`[like] ${label} side-effect "${tasks[i][0]}" failed:`, r.reason);
    }
  });
}

async function handleLikeCreated(event: LifecycleEvent) {
  const { result } = event;
  if (!result?.id) return;

  const like: any = await loadLikeWithRelations({ id: result.id });
  if (!like?.id) return;

  await runSideEffects('create', [
    ['updateLikesCount', updateLikesCount(like)],
    ['createLikeNotification', createLikeNotification(like)],
    ['addLikeExp', addLikeExp(like)],
  ]);
}

async function handleLikeDeleted(event: LifecycleEvent) {
  const like = event?.state?.likeBeforeDelete as { id?: number } | undefined;
  if (!like?.id) return;

  await runSideEffects('delete', [
    ['updateLikesCount', updateLikesCount(like)],
    ['removeUnreadLikeNotification', removeUnreadLikeNotification(like)],
  ]);
}

export async function updateLikesCount(like: any) {
  if (like?.article?.id) {
    const articleDocumentId = like?.article?.documentId;
    const count = await strapi.db.query('api::like.like').count({
      where: {
        article: articleDocumentId
          ? { documentId: articleDocumentId }
          : { id: like.article.id },
      },
    });

    await strapi.db.query('api::article.article').updateMany({
      where: articleDocumentId
        ? { documentId: articleDocumentId }
        : { id: like.article.id },
      data: { likescount: count },
    });
  }

  if (like?.comment?.id) {
    const count = await strapi.db.query('api::like.like').count({
      where: {
        comment: { id: like.comment.id },
      },
    });

    await strapi.db.query('api::comment.comment').update({
      where: { id: like.comment.id },
      data: { likescount: count },
    });
  }
}

async function createLikeNotification(like: any) {
  // 匿名帖/匿名评论被点赞不发通知
  if (like?.article?.isAnonymous) return;
  if (like?.comment?.isAnonymous) return;

  const senderId = like?.user?.id;
  const recipientId = like?.article?.author?.user?.id || like?.comment?.author?.user?.id;

  if (!senderId || !recipientId || senderId === recipientId) return;

  await strapi.db.query('api::notification.notification').create({
    data: {
      type: 'like',
      recipient: recipientId,
      sender: senderId,
      Article: like?.article?.id,
      Comment: like?.comment?.id,
      isRead: false,
    },
  });
}

export async function removeUnreadLikeNotification(like: any) {
  const senderId = like?.user?.id;
  const recipientId = like?.article?.author?.user?.id || like?.comment?.author?.user?.id;

  if (!senderId || !recipientId || senderId === recipientId) return;

  // Strapi db.query.deleteMany 不支持嵌套关联表的 where 条件，
  // 需要先 findMany 取 id 列表，再按 id 批量删除。
  const findWhere: any = {
    type: 'like',
    sender: { id: senderId },
    recipient: { id: recipientId },
  };

  if (like?.article?.id) {
    findWhere.Article = { id: like.article.id };
  }

  if (like?.comment?.id) {
    findWhere.Comment = { id: like.comment.id };
  }

  const candidates = await strapi.db
    .query('api::notification.notification')
    .findMany({
      where: findWhere,
      select: ['id'],
      limit: 500,
    });

  const ids = candidates.map((r) => r.id).filter((id) => Number.isInteger(id));
  if (ids.length === 0) return;

  await strapi.db.query('api::notification.notification').deleteMany({
    where: { id: { $in: ids } },
  });

  // 通知删除后需失效会话缓存，否则未读计数不会更新
  try {
    const { getRedis } = require('../../../../utils/redis');
    const redis = getRedis();
    await Promise.all([
      redis.del(`knock:conv:${recipientId}`),
      redis.del(`dm:conv-list:${recipientId}`),
    ]);
  } catch {
    /* redis 不可用就让 TTL 自然恢复 */
  }
}

async function addLikeExp(like: any) {
  try {
    const senderId = like?.user?.id;
    const recipientId = like?.article?.author?.user?.id || like?.comment?.author?.user?.id;
    if (!senderId || !recipientId || senderId === recipientId) return;

    const { addExp } = require('../../../../utils/level');

    // 统一走 addExp：经验日志审计 + 按 relatedId 去重 + 日上限
    // （主动行为 50/日，互动收益 1000/日），杜绝切换点赞无限刷经验。
    // 点赞者：主动行为 +1
    await addExp(strapi, senderId, 1, 'create_like', 'api::like.like', like.id);
    // 被点赞者：互动收益 +1
    await addExp(strapi, recipientId, 1, 'like_received', 'api::like.like', like.id);
  } catch (err) {
    strapi.log.error('Error adding exp for like:', err);
  }
}
