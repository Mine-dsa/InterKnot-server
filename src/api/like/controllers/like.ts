/**
 * like controller
 */

import { factories } from '@strapi/strapi';
import { parsePagination, getErrorMessage } from '../../../utils/common';

type TargetType = 'article' | 'comment';
const MAX_TARGET_IDS = 100;

const normalizeTargetType = (raw: unknown): TargetType | null => {
  if (raw === 'article' || raw === 'comment') return raw;
  if (typeof raw !== 'string') return null;

  const value = raw.trim().toLowerCase();
  if (value === 'article' || value === 'comment') return value;
  return null;
};

const parseTargetIds = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
      )
    ).slice(0, MAX_TARGET_IDS);
  }

  if (typeof raw !== 'string') return [];

  return Array.from(
    new Set(
      raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_TARGET_IDS);
};

export default factories.createCoreController(
  'api::like.like',
  ({ strapi }) => ({
    async toggle(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const targetType = normalizeTargetType(ctx.request?.body?.targetType);
      const targetIdRaw = ctx.request?.body?.targetId;
      const targetId = typeof targetIdRaw === 'string' ? targetIdRaw.trim() : '';

      if (!targetType) return ctx.badRequest('Invalid targetType');
      if (!targetId) return ctx.badRequest('Missing targetId');

      const where: any = {
        user: { id: user.id },
        [targetType]: { documentId: targetId },
      };

      const existing = await strapi.db.query('api::like.like').findOne({
        where,
        select: ['id'],
      });

      if (existing?.id) {
        await strapi.db.query('api::like.like').delete({
          where: { id: existing.id },
        });

        const count = await strapi.db.query('api::like.like').count({
          where: {
            [targetType]: { documentId: targetId },
          },
        });

        ctx.send({ liked: false, likesCount: count });
        return;
      }

      const targetUid = targetType === 'article' ? 'api::article.article' : 'api::comment.comment';
      const targetWhere =
        targetType === 'article'
          ? { documentId: targetId, publishedAt: { $notNull: true } }
          : { documentId: targetId };
      const target = await strapi.db.query(targetUid).findOne({
        where: targetWhere,
        select: ['id'],
      });

      if (!target?.id) return ctx.notFound('Target not found');

      try {
        await strapi.db.query('api::like.like').create({
          data: {
            user: user.id,
            [targetType]: target.id,
          },
        });
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        if (message.includes('Already liked')) {
          const currentCount = await strapi.db.query('api::like.like').count({
            where: {
              [targetType]: { documentId: targetId },
            },
          });
          ctx.send({ liked: true, likesCount: currentCount });
          return;
        }
        if (message.includes('Like target must be either article or comment')) {
          return ctx.badRequest('Invalid like target');
        }
        throw err;
      }

      const count = await strapi.db.query('api::like.like').count({
        where: {
          [targetType]: { documentId: targetId },
        },
      });

      ctx.send({ liked: true, likesCount: count });
    },

    async check(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const targetType = normalizeTargetType(ctx.query?.targetType);
      if (!targetType) return ctx.badRequest('Invalid targetType');

      const targetIds = parseTargetIds(ctx.query?.targetIds);
      if (!targetIds.length) {
        ctx.send({ data: {} });
        return;
      }

      const likes = await strapi.db.query('api::like.like').findMany({
        where: {
          user: { id: user.id },
          [targetType]: { documentId: { $in: targetIds } },
        },
        select: ['id'],
        populate: {
          [targetType]: {
            select: ['documentId'],
          },
        },
      });

      const likedSet = new Set(
        (likes || [])
          .map((item: any) => item?.[targetType]?.documentId)
          .filter((value: any) => typeof value === 'string' && value)
      );

      const result = targetIds.reduce((acc: Record<string, boolean>, id: string) => {
        acc[id] = likedSet.has(id);
        return acc;
      }, {});

      ctx.send({ data: result });
    },

    async myList(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const targetType = normalizeTargetType(ctx.query?.targetType);
      if (ctx.query?.targetType && !targetType) {
        return ctx.badRequest('Invalid targetType');
      }

      const { start, limit } = parsePagination(ctx.query?.start, ctx.query?.limit);

      const where: any = {
        user: { id: user.id },
      };

      if (targetType === 'article') {
        where.article = { id: { $notNull: true } };
      }
      if (targetType === 'comment') {
        where.comment = { id: { $notNull: true } };
      }

      const [data, total] = await Promise.all([
        strapi.db.query('api::like.like').findMany({
          offset: start,
          limit,
          orderBy: { createdAt: 'desc' },
          where,
          select: ['documentId', 'createdAt'],
          populate: {
            article: {
              select: ['documentId', 'title', 'updatedAt', 'likescount'],
            },
            comment: {
              select: ['documentId', 'content', 'createdAt', 'likescount'],
              populate: {
                article: {
                  select: ['documentId', 'title'],
                },
              },
            },
          },
        }),
        strapi.db.query('api::like.like').count({ where }),
      ]);

      const list = (data || []).map((item: any) => ({
        documentId: item?.documentId,
        createdAt: item?.createdAt,
        targetType: item?.article ? 'article' : 'comment',
        article: item?.article
          ? {
              documentId: item.article.documentId,
              title: item.article.title,
              updatedAt: item.article.updatedAt,
              // 对外统一驼峰：与 /api/articles/list、/api/comments/list、/api/likes/toggle
              // 等其他 endpoint 字段名风格一致，避免前端解析时还要分支处理。
              likesCount: item.article.likescount ?? 0,
            }
          : null,
        comment: item?.comment
          ? {
              documentId: item.comment.documentId,
              content: item.comment.content,
              createdAt: item.comment.createdAt,
              likesCount: item.comment.likescount ?? 0,
              article: item?.comment?.article
                ? {
                    documentId: item.comment.article.documentId,
                    title: item.comment.article.title,
                  }
                : null,
            }
          : null,
      }));

      ctx.send({
        data: list,
        meta: {
          pagination: {
            start,
            limit,
            total,
            pageCount: limit > 0 ? Math.ceil(total / limit) : 0,
          },
        },
      });
    },
  })
);
