/**
 * favorite controller
 */

import { factories } from '@strapi/strapi';
import { parsePagination, getErrorMessage } from '../../../utils/common';

const FAVORITE_UID = 'api::favorite.favorite';
const ARTICLE_UID = 'api::article.article';
const MAX_TARGET_IDS = 100;

const parseTargetIds = (raw: unknown): string[] => {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  return Array.from(
    new Set(
      source
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    )
  ).slice(0, MAX_TARGET_IDS);
};

export default factories.createCoreController(
  FAVORITE_UID,
  ({ strapi }) => ({
    async listLite(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const { start: safeStart, limit: safeLimit } = parsePagination(
        ctx.query?.start,
        ctx.query?.limit
      );

      const where = {
        user: { id: user.id },
      };

      const [data, total] = await Promise.all([
        strapi.db.query(FAVORITE_UID).findMany({
          offset: safeStart,
          limit: safeLimit,
          orderBy: { createdAt: 'desc' },
          where,
          populate: {
            article: { fields: ['documentId', 'updatedAt'] },
          } as any,
        }),
        strapi.db.query(FAVORITE_UID).count({ where }),
      ]);

      ctx.send({
        data,
        meta: {
          pagination: {
            start: safeStart,
            limit: safeLimit,
            total,
            pageCount: safeLimit > 0 ? Math.ceil(total / safeLimit) : 0,
          },
        },
      });
    },

    /**
     * 收藏 / 取消收藏（仅针对文章）。
     * body: { targetId: 文章 documentId }
     * 返回: { favorited, favoritesCount }
     */
    async toggle(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const targetIdRaw = ctx.request?.body?.targetId ?? ctx.request?.body?.articleDocumentId;
      const targetId = typeof targetIdRaw === 'string' ? targetIdRaw.trim() : '';
      if (!targetId) return ctx.badRequest('Missing targetId');

      const countFor = () =>
        strapi.db.query(FAVORITE_UID).count({
          where: { article: { documentId: targetId } },
        });

      const existing = await strapi.db.query(FAVORITE_UID).findOne({
        where: {
          user: { id: user.id },
          article: { documentId: targetId },
        },
        select: ['id'],
      });

      if (existing?.id) {
        await strapi.db.query(FAVORITE_UID).delete({
          where: { id: existing.id },
        });
        ctx.send({ favorited: false, favoritesCount: await countFor() });
        return;
      }

      const target = await strapi.db.query(ARTICLE_UID).findOne({
        where: { documentId: targetId, publishedAt: { $notNull: true } },
        select: ['id'],
      });
      if (!target?.id) return ctx.notFound('Target not found');

      try {
        await strapi.db.query(FAVORITE_UID).create({
          data: {
            user: user.id,
            article: target.id,
          },
        });
      } catch (err: unknown) {
        if (getErrorMessage(err).includes('Already favorited')) {
          ctx.send({ favorited: true, favoritesCount: await countFor() });
          return;
        }
        throw err;
      }

      ctx.send({ favorited: true, favoritesCount: await countFor() });
    },

    /**
     * 批量查询当前用户对一组文章的收藏状态。
     * query: { targetIds: 逗号分隔或数组的文章 documentId }
     * 返回: { data: { [documentId]: boolean } }
     */
    async check(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const targetIds = parseTargetIds(ctx.query?.targetIds);
      if (!targetIds.length) {
        ctx.send({ data: {} });
        return;
      }

      const favorites = await strapi.db.query(FAVORITE_UID).findMany({
        where: {
          user: { id: user.id },
          article: { documentId: { $in: targetIds } },
        },
        select: ['id'],
        populate: {
          article: { select: ['documentId'] },
        },
      });

      const favoritedSet = new Set(
        (favorites || [])
          .map((item: any) => item?.article?.documentId)
          .filter((value: any) => typeof value === 'string' && value)
      );

      const result = targetIds.reduce((acc: Record<string, boolean>, id: string) => {
        acc[id] = favoritedSet.has(id);
        return acc;
      }, {});

      ctx.send({ data: result });
    },
  })
);
