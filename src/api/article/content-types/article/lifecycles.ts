import type { LifecycleEvent } from '../../../../types/strapi';

/**
 * 已发布文章兜底 bumpedAt：
 * API 发帖路径会在控制器里显式写入 bumpedAt，但在 Strapi 后台（admin）
 * 直接建帖/发布时不会经过该控制器，导致 bumpedAt 为空、在主推流
 * （按 bumpedAt:desc 排序）里位置异常。此处在写库前补齐：
 * - 仅处理已发布条目（publishedAt 非空），草稿不顶帖；
 * - 请求已显式携带 bumpedAt（如 API 路径）则保持不变；
 * - 更新时若库中已有 bumpedAt 则保留原值，避免编辑顶帖。
 */
async function ensureBumpedAtOnPublish(event: LifecycleEvent) {
  const data = event?.params?.data;
  if (!data || typeof data !== 'object') return;
  if (!data.publishedAt) return;
  if (data.bumpedAt) return;

  const where = event?.params?.where;
  if (where) {
    try {
      const existing = (await strapi.db.query('api::article.article').findOne({
        where,
        select: ['bumpedAt'],
      })) as { bumpedAt?: string | Date | null } | null;
      if (existing?.bumpedAt) return;
    } catch (err) {
      strapi.log?.warn?.(`[bumpedAt] failed to read existing bumpedAt: ${err}`);
    }
  }

  data.bumpedAt = data.publishedAt;
}

export default {
  async beforeCreate(event: LifecycleEvent) {
    await ensureBumpedAtOnPublish(event);
  },

  async beforeUpdate(event: LifecycleEvent) {
    await ensureBumpedAtOnPublish(event);
  },

  async afterCreate(event: LifecycleEvent) {
    const { result } = event;
    
    try {
      const { addExp } = require('../../../../utils/level');

      // populate author and author.user
        const article: any = await strapi.db.query('api::article.article').findOne({
          where: { id: result.id },
          populate: {
          author: {
            populate: ['user']
          }
        }
      });

      const userId = article?.author?.user?.id;
      
      if (userId) {
        // action: 'create_article', relatedType: 'api::article.article', relatedId: result.id
        await addExp(strapi, userId, 4, 'create_article', 'api::article.article', result.id);
      }
    } catch (err) {
      strapi.log.error('Error adding exp for article creation:', err);
    }

  },

  async beforeDelete(event: LifecycleEvent) {
    // 在物理删除前，捕获 article 的 documentId 与 author.id，供 afterDelete 清理
    event.state = event.state || {};
    try {
      const where = event?.params?.where || {};
      const lookup = where.id
        ? { id: where.id }
        : where.documentId
          ? { documentId: where.documentId }
          : null;
      if (!lookup) return;
      const article: any = await strapi.db.query('api::article.article').findOne({
        where: lookup,
        select: ['id', 'documentId'],
        populate: { author: { select: ['id', 'documentId'] } },
      });
      if (article?.documentId && article?.author?.documentId) {
        event.state.articleBeforeDelete = {
          documentId: article.documentId,
          authorDocumentId: article.author.documentId,
          authorId: article.author.id,
        };
      }
    } catch (err) {
      strapi.log.error('Error capturing article before delete:', err);
    }
  },

  async afterDelete(event: LifecycleEvent) {
    const cached = event?.state?.articleBeforeDelete as
      | { documentId?: string; authorDocumentId?: string; authorId?: number }
      | undefined;
    if (!cached?.documentId || !cached?.authorDocumentId) return;
    try {
      const author: any = await strapi.db.query('api::author.author').findOne({
        where: { id: cached.authorId },
        select: ['id', 'documentId', 'profilePinnedArticles'],
      });
      const pinned = author?.profilePinnedArticles;
      if (!Array.isArray(pinned) || pinned.length === 0) return;
      const next = pinned.filter(
        (id: unknown) => typeof id === 'string' && id !== cached.documentId,
      );
      if (next.length === pinned.length) return;
      await strapi.documents('api::author.author').update({
        documentId: cached.authorDocumentId,
        data: { profilePinnedArticles: next },
      });
    } catch (err) {
      strapi.log.error('Error cleaning up profilePinnedArticles after article delete:', err);
    }
  },
};
