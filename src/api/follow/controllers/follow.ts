/**
 * follow controller
 */

import { factories } from '@strapi/strapi';
import { parsePagination, getErrorMessage } from '../../../utils/common';

const FOLLOW_UID = 'api::follow.follow';
const AUTHOR_UID = 'api::author.author';
const MAX_TARGET_IDS = 100;

const parseAuthorIds = (raw: unknown): string[] => {
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
  FOLLOW_UID,
  ({ strapi }) => ({
    /**
     * 关注 / 取消关注某作者。
     * body: { authorDocumentId }
     * 返回: { following, followersCount }
     */
    async toggle(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const authorDocumentIdRaw =
        ctx.request?.body?.authorDocumentId ?? ctx.request?.body?.targetId;
      const authorDocumentId =
        typeof authorDocumentIdRaw === 'string' ? authorDocumentIdRaw.trim() : '';
      if (!authorDocumentId) return ctx.badRequest('Missing authorDocumentId');

      const author = await strapi.db.query(AUTHOR_UID).findOne({
        where: { documentId: authorDocumentId },
        select: ['id'],
        populate: { user: { select: ['id'] } },
      });
      if (!author?.id) return ctx.notFound('Author not found');
      if (author?.user?.id === user.id) {
        return ctx.badRequest('Cannot follow yourself');
      }

      const countFor = () =>
        strapi.db.query(FOLLOW_UID).count({
          where: { following: { id: author.id } },
        });

      const existing = await strapi.db.query(FOLLOW_UID).findOne({
        where: {
          follower: { id: user.id },
          following: { id: author.id },
        },
        select: ['id'],
      });

      if (existing?.id) {
        await strapi.db.query(FOLLOW_UID).delete({ where: { id: existing.id } });
        ctx.send({ following: false, followersCount: await countFor() });
        return;
      }

      try {
        await strapi.db.query(FOLLOW_UID).create({
          data: {
            follower: user.id,
            following: author.id,
          },
        });
      } catch (err: unknown) {
        if (getErrorMessage(err).includes('Already following')) {
          ctx.send({ following: true, followersCount: await countFor() });
          return;
        }
        throw err;
      }

      ctx.send({ following: true, followersCount: await countFor() });
    },

    /**
     * 批量查询当前用户对一组作者的关注状态。
     * query: { authorIds: 逗号分隔或数组的作者 documentId }
     * 返回: { data: { [documentId]: boolean } }
     */
    async check(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const authorIds = parseAuthorIds(ctx.query?.authorIds);
      if (!authorIds.length) {
        ctx.send({ data: {} });
        return;
      }

      const follows = await strapi.db.query(FOLLOW_UID).findMany({
        where: {
          follower: { id: user.id },
          following: { documentId: { $in: authorIds } },
        },
        select: ['id'],
        populate: {
          following: { select: ['documentId'] },
        },
      });

      const followingSet = new Set(
        (follows || [])
          .map((item: any) => item?.following?.documentId)
          .filter((value: any) => typeof value === 'string' && value)
      );

      const result = authorIds.reduce((acc: Record<string, boolean>, id: string) => {
        acc[id] = followingSet.has(id);
        return acc;
      }, {});

      ctx.send({ data: result });
    },

    /**
     * 当前用户关注的作者列表（精简）。
     * 返回: { data: [{ documentId, name }], meta.pagination }
     */
    async followingList(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const { start: safeStart, limit: safeLimit } = parsePagination(
        ctx.query?.start,
        ctx.query?.limit
      );

      const where = { follower: { id: user.id } };

      const [data, total] = await Promise.all([
        strapi.db.query(FOLLOW_UID).findMany({
          offset: safeStart,
          limit: safeLimit,
          orderBy: { createdAt: 'desc' },
          where,
          select: ['id', 'createdAt'],
          populate: {
            following: {
              select: ['documentId', 'name'],
              populate: { avatar: { select: ['url'] } },
            },
          },
        }),
        strapi.db.query(FOLLOW_UID).count({ where }),
      ]);

      const list = (data || [])
        .map((item: any) => item?.following)
        .filter((author: any) => author?.documentId)
        .map((author: any) => ({
          documentId: author.documentId,
          name: author.name,
          avatar: author?.avatar?.url ?? null,
        }));

      ctx.send({
        data: list,
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
  })
);
