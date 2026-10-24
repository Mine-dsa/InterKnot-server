/**
 * author controller
 */

import { factories } from '@strapi/strapi';
import { batchResolveEquippedAvatars, withSmallWebp } from '../../../utils/common';
import { getRedis } from '../../../utils/redis';

const MAX_PAGE_LIMIT = 50;
const ARTICLE_UID = 'api::article.article';
const LIKE_UID = 'api::like.like';
const FOLLOW_UID = 'api::follow.follow';
export const PROFILE_PINNED_MAX = 6;

/** /authors/search 的限流：每个用户 1 秒内最多 10 次。 */
const SEARCH_RATE_LIMIT_PER_SEC = 10;
const SEARCH_RATE_WINDOW_SEC = 1;
const SEARCH_QUERY_MAX_LEN = 32;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 10;

/**
 * 规范化 profilePinnedArticles 字段值。
 * - null / undefined → null（未配置）
 * - 数组 → 去掉非字符串、trim、去除空字符串、去重保序
 * - 其他类型 → null
 */
const normalizePinned = (raw: unknown): string[] | null => {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

export default factories.createCoreController(
  'api::author.author',
  ({ strapi }) => ({
    async profile(ctx) {
      const documentIdRaw = ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const authorParams: any = {
        filters: { documentId },
        limit: 1,
        fields: ['documentId', 'name', 'bio'],
        populate: {
          avatar: { fields: ['url', 'width', 'height'] },
          user: {
            fields: ['id', 'username', 'level', 'exp', 'profileHidden', 'isAiAgent'],
          },
        },
      };

      const author = await strapi.entityService.findMany(
        'api::author.author',
        authorParams
      );

      const authorItem: any = Array.isArray(author) ? author[0] : author;
      if (!authorItem) return ctx.notFound();

      // Fetch equippedCard / equippedAvatar separately via user id (nested populate through relations is unreliable)
      let equippedCardData: any = null;
      let equippedAvatarData: any = null;
      let equippedTitleData: any = null;
      let equippedMedalData: any = null;
      const ownerUserId = authorItem?.user?.id;
      if (ownerUserId) {
        const userWithCard = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { id: ownerUserId },
          populate: {
            equippedCard: {
              populate: {
                image: { select: ['url', 'width', 'height'] },
              },
            },
            equippedAvatar: {
              populate: {
                image: { select: ['url', 'width', 'height'] },
              },
            },
            equippedTitle: {
              select: ['documentId', 'name', 'rarity'],
              populate: { image: { select: ['url', 'width', 'height'] } },
            },
            equippedMedal: {
              select: ['documentId', 'name', 'rarity'],
              populate: { image: { select: ['url', 'width', 'height'] } },
            },
          },
        });
        equippedCardData = userWithCard?.equippedCard ?? null;
        equippedAvatarData = userWithCard?.equippedAvatar ?? null;
        equippedTitleData = userWithCard?.equippedTitle ?? null;
        equippedMedalData = userWithCard?.equippedMedal ?? null;
      }

      // 主页统计仅暴露非匿名内容；匿名帖对所有人（包括作者本人）一律不计入。
      const NON_ANON_FILTER = {
        $or: [
          { isAnonymous: { $null: true } },
          { isAnonymous: false },
        ],
      };

      const articleWhere = {
        author: { id: authorItem.id },
        publishedAt: {
          $notNull: true,
        },
        ...NON_ANON_FILTER,
      };
      const commentWhere = {
        author: { id: authorItem.id },
        article: {
          id: {
            $notNull: true,
          },
        },
        ...NON_ANON_FILTER,
      };

      const [articleCount, articleRows, commentCount] = await Promise.all([
        strapi.db.query(ARTICLE_UID).count({ where: articleWhere }),
        strapi.db.query(ARTICLE_UID).findMany({
          where: articleWhere,
          select: ['id', 'views'],
        }),
        strapi.db.query('api::comment.comment').count({ where: commentWhere }),
      ]);

      const articleIds = (articleRows || [])
        .map((item: any) => item?.id)
        .filter((id: unknown): id is number => typeof id === 'number');

      const totalViews = (articleRows || []).reduce(
        (acc: number, item: any) => acc + (item?.views ?? 0),
        0,
      );

      let totalComments = 0;
      let totalLikes = 0;
      if (articleIds.length > 0) {
        // 关联 where 不能与 $or 混用，先取文章 id 再统计评论/点赞
        [totalComments, totalLikes] = await Promise.all([
          strapi.db.query('api::comment.comment').count({
            where: {
              article: { id: { $in: articleIds } },
            },
          }),
          strapi.db.query(LIKE_UID).count({
            where: {
              article: { id: { $in: articleIds } },
            },
          }),
        ]);
      }

      const currentUserId = ctx.state?.user?.id ?? null;
      const ownerUser = authorItem?.user ?? null;
      const equippedCard = equippedCardData;
      const equippedAvatar = equippedAvatarData;
      const isSelf = !!(currentUserId && ownerUser?.id === currentUserId);
      const isHidden = !!ownerUser?.profileHidden && !isSelf;

      // 关注关系：粉丝数（被关注）、关注数（该用户关注的作者）、以及当前访客是否已关注。
      const [followersCount, followingCount, viewerFollow] = await Promise.all([
        strapi.db.query(FOLLOW_UID).count({
          where: { following: { id: authorItem.id } },
        }),
        ownerUser?.id
          ? strapi.db.query(FOLLOW_UID).count({
              where: { follower: { id: ownerUser.id } },
            })
          : Promise.resolve(0),
        currentUserId && !isSelf
          ? strapi.db.query(FOLLOW_UID).findOne({
              where: {
                follower: { id: currentUserId },
                following: { id: authorItem.id },
              },
              select: ['id'],
            })
          : Promise.resolve(null),
      ]);
      const isFollowing = !!viewerFollow?.id;

      if (isHidden) {
        ctx.send({
          data: {
            userId: ownerUser?.id ?? null,
            documentId: authorItem?.documentId,
            name: authorItem?.name,
            bio: [],
            avatar: authorItem?.avatar ?? null,
            user: ownerUser
              ? {
                  username: ownerUser?.username,
                  level: ownerUser?.level ?? 1,
                  exp: 0,
                }
              : null,
            equippedCard: null,
            equippedAvatar: null,
            isSelf: false,
            isHidden: true,
            profileHidden: true,
            isFollowing,
            followersCount,
            followingCount,
            stats: null,
          },
        });
        return;
      }

      ctx.send({
        data: {
          userId: ownerUser?.id ?? null,
          documentId: authorItem?.documentId,
          name: authorItem?.name,
          bio: authorItem?.bio ?? [],
          avatar: authorItem?.avatar ?? null,
          user: ownerUser
            ? {
                username: ownerUser?.username,
                level: ownerUser?.level ?? 1,
                exp: ownerUser?.exp ?? 0,
              }
            : null,
          equippedCard: equippedCard
            ? {
                documentId: equippedCard.documentId,
                name: equippedCard.name,
                description: equippedCard.description,
                type: equippedCard.type,
                image: equippedCard.image ?? null,
              }
            : null,
          equippedAvatar: equippedAvatar
            ? {
                documentId: equippedAvatar.documentId,
                name: equippedAvatar.name,
                type: equippedAvatar.type,
                image: equippedAvatar.image ?? null,
              }
            : null,
          equippedTitle: equippedTitleData
            ? {
                documentId: equippedTitleData.documentId,
                name: equippedTitleData.name,
                rarity: equippedTitleData.rarity ?? 'common',
                image: equippedTitleData.image ?? null,
              }
            : null,
          equippedMedal: equippedMedalData
            ? {
                documentId: equippedMedalData.documentId,
                name: equippedMedalData.name,
                rarity: equippedMedalData.rarity ?? 'common',
                image: equippedMedalData.image ?? null,
              }
            : null,
          isSelf,
          isHidden: false,
          profileHidden: !!ownerUser?.profileHidden,
          isAiAgent: ownerUser?.isAiAgent === true,
          isFollowing,
          followersCount,
          followingCount,
          stats: {
            articleCount,
            commentCount,
            totalViews,
            totalComments,
            totalLikes,
          },
        },
      });
    },

    async profileArticles(ctx) {
      const documentIdRaw = ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const startRaw = ctx.query?.start;
      const limitRaw = ctx.query?.limit;
      const start = Number.isNaN(Number.parseInt(String(startRaw), 10))
        ? 0
        : Number.parseInt(String(startRaw), 10);
      const limit = Number.isNaN(Number.parseInt(String(limitRaw), 10))
        ? 10
        : Number.parseInt(String(limitRaw), 10);

      const safeStart = start < 0 ? 0 : start;
      const safeLimit = limit < 1 ? 10 : Math.min(limit, MAX_PAGE_LIMIT);

      const authorParams: any = {
        filters: { documentId },
        limit: 1,
        fields: ['documentId', 'name', 'profilePinnedArticles'],
        populate: {
          avatar: { fields: ['url', 'width', 'height'] },
          user: { fields: ['id', 'profileHidden'] },
        },
      };

      const authors = await strapi.entityService.findMany(
        'api::author.author',
        authorParams
      );

      const authorItem: any = Array.isArray(authors) ? authors[0] : authors;
      if (!authorItem) return ctx.notFound();

      const currentUserId = ctx.state?.user?.id ?? null;
      const ownerUser = authorItem?.user ?? null;
      const isSelf = !!(currentUserId && ownerUser?.id === currentUserId);
      if (ownerUser?.profileHidden && !isSelf) {
        ctx.send({
          data: [],
          meta: { pagination: { start: 0, limit: safeLimit, total: 0, pageCount: 0 } },
        });
        return;
      }

      // 主页文章列表对所有人（包括作者本人）隐藏匿名文章。
      const NON_ANON_FILTER_LIST = {
        $or: [
          { isAnonymous: { $null: true } },
          { isAnonymous: false },
        ],
      };

      const profileOwnerUserId = authorItem?.user?.id;
      const profileAvatarMap = typeof profileOwnerUserId === 'number'
        ? await batchResolveEquippedAvatars(strapi, [profileOwnerUserId])
        : new Map();
      const profileEquippedImage = typeof profileOwnerUserId === 'number'
        ? profileAvatarMap.get(profileOwnerUserId)
        : undefined;
      const authorData = {
        documentId: authorItem?.documentId,
        name: authorItem?.name,
        avatar: profileEquippedImage
          ? withSmallWebp(profileEquippedImage)
          : authorItem?.avatar ? withSmallWebp(authorItem.avatar) : null,
      };

      const pinned = normalizePinned(authorItem?.profilePinnedArticles);

      // 精选已配置（即使是空数组）
      let articles: Record<string, unknown>[] = [];
      let total = 0;
      let isPinnedMode = false;

      if (pinned !== null) {
        isPinnedMode = true;
        if (pinned.length === 0) {
          // 主动清空，主页不展示任何帖子
          articles = [];
          total = 0;
        } else {
          const pinnedFilters = {
            author: { id: authorItem.id },
            documentId: { $in: pinned },
            ...NON_ANON_FILTER_LIST,
          };
          const found = await strapi.documents(ARTICLE_UID).findMany({
            status: 'published',
            limit: PROFILE_PINNED_MAX,
            filters: pinnedFilters,
            fields: [
              'documentId',
              'title',
              'views',
              'commentscount',
              'likescount',
              'createdAt',
              'updatedAt',
            ],
            populate: {
              cover: { fields: ['url', 'width', 'height'] },
            },
          });
          // 按 pinned 数组顺序排序，过滤已删除/未发布
          const map = new Map<string, any>();
          for (const item of found || []) {
            if (item?.documentId) map.set(item.documentId, item);
          }
          articles = pinned.map((id) => map.get(id)).filter(Boolean);
          total = articles.length;
        }
      } else {
        const where = {
          author: { id: authorItem.id },
          ...NON_ANON_FILTER_LIST,
        };
        [articles, total] = await Promise.all([
          strapi.documents(ARTICLE_UID).findMany({
            status: 'published',
            start: safeStart,
            limit: safeLimit,
            sort: ['updatedAt:desc'],
            filters: where,
            fields: [
              'documentId',
              'title',
              'views',
              'commentscount',
              'likescount',
              'createdAt',
              'updatedAt',
            ],
            populate: {
              cover: { fields: ['url', 'width', 'height'] },
            },
          }),
          strapi.documents(ARTICLE_UID).count({ status: 'published', filters: where }),
        ]);
      }

      const data = (articles || []).map((item: any) => {
        const coverList = Array.isArray(item?.cover)
          ? item.cover
          : item?.cover
            ? [item.cover]
            : [];
        const cover = coverList[0] ?? null;

        // body text intentionally omitted: profile cards no longer render an excerpt.
        return {
          documentId: item?.documentId,
          title: item?.title,
          cover: cover ? withSmallWebp(cover) : null,
          views: item?.views ?? 0,
          commentsCount: item?.commentscount ?? 0,
          likesCount: item?.likescount ?? 0,
          createdAt: item?.createdAt,
          updatedAt: item?.updatedAt,
          author: authorData,
        };
      });

      ctx.send({
        data,
        meta: {
          pagination: isPinnedMode
            ? {
                start: 0,
                limit: PROFILE_PINNED_MAX,
                total,
                pageCount: total > 0 ? 1 : 0,
              }
            : {
                start: safeStart,
                limit: safeLimit,
                total,
                pageCount: safeLimit > 0 ? Math.ceil(total / safeLimit) : 0,
              },
          pinned: isPinnedMode,
        },
      });
    },

    async profileComments(ctx) {
      const documentIdRaw = ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const startRaw = ctx.query?.start;
      const limitRaw = ctx.query?.limit;
      const start = Number.isNaN(Number.parseInt(String(startRaw), 10))
        ? 0
        : Number.parseInt(String(startRaw), 10);
      const limit = Number.isNaN(Number.parseInt(String(limitRaw), 10))
        ? 20
        : Number.parseInt(String(limitRaw), 10);

      const safeStart = start < 0 ? 0 : start;
      const safeLimit = limit < 1 ? 20 : Math.min(limit, MAX_PAGE_LIMIT);

      const authorParams: any = {
        filters: { documentId },
        limit: 1,
        fields: ['documentId', 'name'],
        populate: {
          avatar: { fields: ['url', 'width', 'height'] },
          user: { fields: ['id', 'username', 'level', 'profileHidden'] },
        },
      };

      const authors = await strapi.entityService.findMany(
        'api::author.author',
        authorParams
      );

      const authorItem: any = Array.isArray(authors) ? authors[0] : authors;
      if (!authorItem) return ctx.notFound();

      {
        const viewerId = ctx.state?.user?.id ?? null;
        const owner = authorItem?.user ?? null;
        const viewerIsSelf = !!(viewerId && owner?.id === viewerId);
        if (owner?.profileHidden && !viewerIsSelf) {
          ctx.send({
            data: [],
            meta: { pagination: { start: 0, limit: safeLimit, total: 0, pageCount: 0 } },
          });
          return;
        }
      }

      // 评论列表对所有人（包括作者本人）隐藏匿名评论。
      const COMMENT_NON_ANON_FILTER = {
        $or: [
          { isAnonymous: { $null: true } },
          { isAnonymous: false },
        ],
      };

      const where = {
        author: { id: authorItem.id },
        article: {
          id: {
            $notNull: true,
          },
        },
        ...COMMENT_NON_ANON_FILTER,
      };

      const commentParams: any = {
        start: safeStart,
        limit: safeLimit,
        sort: ['createdAt:desc'],
        filters: where,
        fields: ['documentId', 'content', 'createdAt', 'likescount'],
        populate: {
          article: {
            fields: ['documentId', 'title'],
            populate: {
              cover: { fields: ['url', 'width', 'height'] },
            },
          },
          author: {
            fields: ['documentId', 'name'],
            populate: {
              avatar: { fields: ['url', 'width', 'height'] },
              user: { fields: ['id', 'level'] },
            },
          },
          // 不再 populate parent：与 listLite 保持一致。
          // 历史上 parent 输出过 `parent.author.name`，但因为 parent 可能是匿名评论，
          // 直接透传等于把匿名作者真实身份泄漏出来——隐私 bug。
          // 统一不展示 parent 摘要：用户点进评论关联的文章即可看到完整上下文。
        },
      };

      const [rawComments, total] = await Promise.all([
        strapi.entityService.findMany('api::comment.comment', commentParams),
        strapi.db.query('api::comment.comment').count({ where }),
      ]);

      const comments = Array.isArray(rawComments) ? rawComments : [];
      const commentDocumentIds = comments
        .map((item: any) => item?.documentId)
        .filter((item: any) => typeof item === 'string' && item);

      let likedSet = new Set<string>();
      const currentUserId = ctx.state?.user?.id;

      if (currentUserId && commentDocumentIds.length > 0) {
        const likes = await strapi.db.query('api::like.like').findMany({
          where: {
            user: { id: currentUserId },
            comment: {
              documentId: {
                $in: commentDocumentIds,
              },
            },
          },
          select: ['id'],
          populate: {
            comment: {
              select: ['documentId'],
            },
          },
        });

        likedSet = new Set(
          (likes || [])
            .map((like: any) => like?.comment?.documentId)
            .filter((item: any) => typeof item === 'string' && item)
        );
      }

      const commentUserIds = [...new Set(
        comments
          .map((item: any) => item?.author?.user?.id)
          .filter((id: unknown): id is number => typeof id === 'number')
      )];
      const commentAvatarMap = await batchResolveEquippedAvatars(strapi, commentUserIds);

      const data = comments.map((item: any) => {
        const authorUserId = item?.author?.user?.id;
        const equippedImg = typeof authorUserId === 'number' ? commentAvatarMap.get(authorUserId) : undefined;
        return {
        documentId: item?.documentId,
        content: item?.content,
        createdAt: item?.createdAt,
        likesCount: item?.likescount ?? 0,
        liked: likedSet.has(item?.documentId),
        author: item?.author
          ? {
              documentId: item?.author?.documentId ?? null,
              name: item?.author?.name ?? null,
              avatar: equippedImg
                ? withSmallWebp(equippedImg)
                : item?.author?.avatar
                  ? withSmallWebp(item.author.avatar)
                  : null,
              level: item?.author?.user?.level ?? null,
            }
          : null,
        article: item?.article
          ? {
              documentId: item?.article?.documentId ?? null,
              title: item?.article?.title ?? null,
              cover: item?.article?.cover
                ? withSmallWebp(
                    Array.isArray(item.article.cover)
                      ? item.article.cover[0] ?? null
                      : item.article.cover
                  )
                : null,
            }
          : null,
      };
      });

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
     * 评论编辑器里 @ 触发的用户搜索。
     * - q 必填，trim 后长度 1~SEARCH_QUERY_MAX_LEN
     * - 同时按 author.name 和 user.username 模糊匹配，union 后按 name 升序
     * - 排除 profileHidden / blocked 的用户
     * - 单用户 1 秒 10 次的 Redis 计数限流
     */
    async search(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      // 鲁棒地从 query 中提取参数：兼容 string / string[] / undefined。
      // 之前严格的 `typeof === 'string'` 判定在某些 Koa querystring 解析路径下会落空，
      // 表现为 "Missing q"。三层兜底：ctx.query → ctx.request.query → 直接 URL 解析。
      const pickStr = (raw: unknown): string => {
        if (typeof raw === 'string') return raw;
        if (Array.isArray(raw)) {
          const first = raw[0];
          return typeof first === 'string' ? first : '';
        }
        return '';
      };
      const pickFromUrl = (key: string): string => {
        try {
          const url = new URL(ctx.url ?? '', 'http://placeholder');
          return url.searchParams.get(key) ?? '';
        } catch {
          return '';
        }
      };
      const rawQ =
        pickStr(ctx.query?.q) ||
        pickStr((ctx.request)?.query?.q) ||
        pickFromUrl('q');
      const q = rawQ.trim();
      if (!q) return ctx.badRequest('Missing q');
      if (q.length > SEARCH_QUERY_MAX_LEN) {
        return ctx.badRequest('q too long');
      }

      const limitRawSrc =
        pickStr(ctx.query?.limit) ||
        pickStr((ctx.request)?.query?.limit) ||
        pickFromUrl('limit');
      const limitRaw = Number.parseInt(limitRawSrc, 10);
      const limit = Math.max(
        1,
        Math.min(
          Number.isFinite(limitRaw) && limitRaw > 0
            ? limitRaw
            : SEARCH_DEFAULT_LIMIT,
          SEARCH_MAX_LIMIT,
        ),
      );

      // Redis 限流：失败时静默放行（容忍 Redis 不可用）
      try {
        const redis = getRedis();
        const key = `authors:search:rl:${user.id}`;
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, SEARCH_RATE_WINDOW_SEC);
        }
        if (count > SEARCH_RATE_LIMIT_PER_SEC) {
          return ctx.tooManyRequests('Search rate limit exceeded');
        }
      } catch {
        /* noop */
      }

      // author.name / user.username 两路 OR。
      // blocked / profileHidden 放到 JS 端过滤——把这两个条件叠在 where 里和 $or 里
      // 对 user 的引用混合，会让 Strapi 的 join 合并出现非预期 SQL。
      // 多取一些行做后端二次过滤后再 slice。
      const rows = await strapi.db.query('api::author.author').findMany({
        where: {
          $or: [
            { name: { $containsi: q } },
            { user: { username: { $containsi: q } } },
          ],
        },
        select: ['id', 'documentId', 'name'],
        populate: {
          avatar: { select: ['url', 'width', 'height'] },
          user: {
            select: ['id', 'username', 'level', 'blocked', 'profileHidden'],
          },
        },
        // 取 limit * 4 给后续过滤留缓冲（被 blocked/profileHidden 砍掉一部分）
        limit: limit * 4,
        orderBy: { name: 'asc' },
      });

      // 过滤掉无 user 关联 / 被封禁 / 主页隐藏的用户
      // profileHidden 是用户主动隐藏自己的主页 → 不应出现在 @ 搜索建议里
      const visible = rows.filter((r: any) => {
        const u = r?.user;
        if (!u?.id) return false;
        if (u.blocked === true) return false;
        if (u.profileHidden === true) return false;
        return true;
      });

      const sliced = visible.slice(0, limit);

      // 解析装备头像（与项目其它处一致的批量逻辑）
      const userIds = [
        ...new Set(
          sliced
            .map((r: any) => r?.user?.id)
            .filter((id: unknown): id is number => Number.isInteger(id)),
        ),
      ];
      const avatarMap = await batchResolveEquippedAvatars(strapi, userIds);

      const data = sliced.map((r: any) => {
        const equipped = avatarMap.get(r.user.id);
        const avatarUrl = equipped?.url
          ? `${equipped.url}-small.webp`
          : r?.avatar?.url
            ? `${r.avatar.url}-small.webp`
            : null;
        return {
          documentId: r.documentId,
          name: r.name,
          username: r?.user?.username ?? null,
          level: r?.user?.level ?? null,
          avatar: avatarUrl,
        };
      });

      ctx.send({ data });
    },
  })
);
