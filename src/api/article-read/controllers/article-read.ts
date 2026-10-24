/**
 * article-read controller
 */

import { factories } from '@strapi/strapi';

const MAX_BATCH_ARTICLE_IDS = 100;

export default factories.createCoreController(
  'api::article-read.article-read',
  ({ strapi }) => ({
    async batch(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const body = ctx.request?.body || {};
      const rawIds = body.articleDocumentIds || body?.data?.articleDocumentIds;
      const ids = Array.isArray(rawIds)
        ? rawIds
            .map((id) => (typeof id === 'string' ? id.trim() : ''))
            .filter((id) => id)
            .slice(0, MAX_BATCH_ARTICLE_IDS)
        : [];

      if (ids.length === 0) {
        ctx.send({ data: [] });
        return;
      }

      const shouldMark = !!(body.markAsRead || body?.data?.markAsRead);

      if (shouldMark) {
        // 批量 Upsert：将文章标记为已读（避免逐条 N+1 查询）
        // 1) 一次性解析 documentId -> 内部 id
        const articleRows = await strapi.db.query('api::article.article').findMany({
          where: { documentId: { $in: ids } },
          select: ['id', 'documentId'],
          limit: ids.length,
        });
        const docIdToId = new Map<string, number>();
        for (const row of articleRows || []) {
          if (row?.documentId && typeof row.id === 'number') {
            docIdToId.set(row.documentId, row.id);
          }
        }
        const articleIds = [...docIdToId.values()];

        // 2) 一次性查询当前用户在这些文章上的已有记录
        const existingRows = articleIds.length
          ? await strapi.db.query('api::article-read.article-read').findMany({
              where: { user: user.id, article: { id: { $in: articleIds } } },
              select: ['id', 'isRead'],
              populate: { article: { select: ['id'] } },
            })
          : [];
        const existingByArticleId = new Map<number, { id: number; isRead: boolean }>();
        for (const row of existingRows || []) {
          const articleId = row?.article?.id;
          if (typeof articleId === 'number') {
            existingByArticleId.set(articleId, { id: row.id, isRead: !!row.isRead });
          }
        }

        // 3) 分类：待置为已读的存量记录 / 需新建的记录
        const toUpdateIds: number[] = [];
        const toCreateArticleIds: number[] = [];
        for (const articleId of articleIds) {
          const existing = existingByArticleId.get(articleId);
          if (existing) {
            if (!existing.isRead) toUpdateIds.push(existing.id);
          } else {
            toCreateArticleIds.push(articleId);
          }
        }

        // 4) 单条 update 批量置读
        if (toUpdateIds.length > 0) {
          await strapi.db.query('api::article-read.article-read').update({
            where: { id: { $in: toUpdateIds } },
            data: { isRead: true },
          });
        }

        // 5) 新建记录（Strapi 5 db.query.createMany 不处理 relation，需逐行 create）
        for (const articleId of toCreateArticleIds) {
          await strapi.db.query('api::article-read.article-read').create({
            data: {
              user: user.id,
              article: articleId,
              isRead: true,
            },
          });
        }

        ctx.send({ data: ids.map((id) => ({ articleDocumentId: id, isRead: true })) });
        return;
      }

      const records = await strapi.db
        .query('api::article-read.article-read')
        .findMany({
          where: {
            user: user.id,
            article: { documentId: { $in: ids } },
          },
          populate: { article: { fields: ['documentId'] } },
          select: ['isRead'],
        });

      const data = (records || [])
        .map((record: any) => ({
          articleDocumentId: record?.article?.documentId,
          isRead: !!record?.isRead,
        }))
        .filter((item) => item.articleDocumentId);

      ctx.send({ data });
    },
  })
);
