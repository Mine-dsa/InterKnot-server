import type { Core } from '@strapi/strapi';
import { factories } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { parsePagination, withSmallWebp, batchResolveEquippedAvatars } from '../../../utils/common';
import { getRedis } from '../../../utils/redis';
import { deductDenny } from '../../../utils/denny';
import {
  buildAnonymousAuthor,
  generateAnonymousSeed,
  shouldAnonymize,
} from '../../../utils/anonymous';
import {
  resolveActiveCategory,
  serializeCategory,
} from '../../../utils/categories';
import { searchArticleIndex } from '../../../utils/meilisearch';

/** 解析列表接口的 category 查询参数（slug）。空 / 'all' 视为不过滤。 */
const parseCategorySlug = (raw: unknown): string => {
  const slug = typeof raw === 'string' ? raw.trim() : '';
  return slug && slug !== 'all' ? slug : '';
};

type ArticleFeed = 'recommend' | 'following' | 'favorites';

/** 解析首页 feed 模式：recommend（默认推荐流）/ following（我关注的作者）/ favorites（我的收藏）。 */
const parseFeed = (raw: unknown): ArticleFeed => {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'following' || value === 'favorites') return value;
  return 'recommend';
};

const MAX_FOLLOWING_AUTHORS = 1000;

const ARTICLE_UID = 'api::article.article';
const LIKE_UID = 'api::like.like';
const FAVORITE_UID = 'api::favorite.favorite';
const FOLLOW_UID = 'api::follow.follow';
const getArticleDocuments = (strapi: Core.Strapi) => strapi.documents(ARTICLE_UID);
const { ApplicationError } = errors;

const MAX_ARTICLE_COVERS = 9;
const VIEW_COOLDOWN_SEC = 5 * 60;

/**
 * documentService.findMany/findOne 的 `fields:` 不允许包含 private 字段
 * （anonymousSeed 在 schema 是 `private: true`），会抛 ValidationError。
 * 解决：fields 里不带 anonymousSeed，调完用 db.query 按 documentId 反查补回。
 *
 * 仅对 isAnonymous=true 的记录回填，未匿名记录不查询 seed，省一次 IO。
 * 数组就地 mutate，保留原有调用链。
 */
const attachAnonymousSeeds = async (
  strapi: Core.Strapi,
  items: any[] | any,
): Promise<void> => {
  if (!items) return;
  const list = Array.isArray(items) ? items : [items];
  const targets = list.filter((it) => it?.isAnonymous && it?.documentId);
  if (targets.length === 0) return;

  const documentIds = Array.from(
    new Set(targets.map((it) => it.documentId as string)),
  );

  const rows: Array<{ documentId: string; anonymousSeed: string | null }> =
    await strapi.db.query(ARTICLE_UID).findMany({
      where: { documentId: { $in: documentIds } },
      select: ['documentId', 'anonymousSeed'],
    });

  const seedMap = new Map<string, string | null>();
  for (const row of rows) {
    if (row?.documentId && !seedMap.has(row.documentId)) {
      seedMap.set(row.documentId, row.anonymousSeed ?? null);
    }
  }

  for (const it of targets) {
    it.anonymousSeed = seedMap.get(it.documentId) ?? null;
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const assertArticleCoverLimit = (cover: unknown) => {
  const coverCount = Array.isArray(cover) ? cover.length : cover ? 1 : 0;
  if (coverCount > MAX_ARTICLE_COVERS) {
    throw new ApplicationError(`图片最多只能上传 ${MAX_ARTICLE_COVERS} 张`);
  }
};

const findUploadFileIdByDocumentId = async (
  strapi: Core.Strapi,
  documentId: string,
  cache: Map<string, number>
) => {
  const trimmed = documentId.trim();
  if (!trimmed) return null;

  const cached = cache.get(trimmed);
  if (cached) return cached;

  const file = await strapi.db.query('plugin::upload.file').findOne({
    where: { documentId: trimmed },
    select: ['id'],
  });

  if (!file?.id) return null;

  cache.set(trimmed, file.id);
  return file.id;
};

const resolveMediaReferenceId = async (
  strapi: Core.Strapi,
  value: unknown,
  fieldPath: string,
  cache: Map<string, number>
): Promise<number | null> => {
  if (value == null) return null;

  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
      const numericId = Number.parseInt(trimmed, 10);
      if (numericId > 0) return numericId;
    }

    const fileId = await findUploadFileIdByDocumentId(strapi, trimmed, cache);
    if (fileId) return fileId;
    throw new ApplicationError(
      `${fieldPath} references upload file "${trimmed}" but it does not exist`
    );
  }

  if (isPlainObject(value)) {
    if (typeof value.id === 'number' && Number.isInteger(value.id) && value.id > 0) {
      return value.id;
    }

    if (typeof value.documentId === 'string') {
      const fileId = await findUploadFileIdByDocumentId(strapi, value.documentId, cache);
      if (fileId) return fileId;
      throw new ApplicationError(
        `${fieldPath} references upload file "${value.documentId}" but it does not exist`
      );
    }
  }

  throw new ApplicationError(`${fieldPath} has an unsupported media reference format`);
};

const normalizeSingleMediaField = async (
  strapi: Core.Strapi,
  value: unknown,
  fieldPath: string,
  cache: Map<string, number>
) => {
  if (value == null) return value;

  if (isPlainObject(value)) {
    if (Array.isArray(value.set)) {
      const first = value.set[0];
      return resolveMediaReferenceId(strapi, first, fieldPath, cache);
    }

    if (Array.isArray(value.connect)) {
      const first = value.connect[0];
      return resolveMediaReferenceId(strapi, first, fieldPath, cache);
    }
  }

  return resolveMediaReferenceId(strapi, value, fieldPath, cache);
};

const normalizeMultipleMediaField = async (
  strapi: Core.Strapi,
  value: unknown,
  fieldPath: string,
  cache: Map<string, number>
) => {
  if (value == null) return value;

  const rawItems = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.set)
      ? value.set
      : isPlainObject(value) && Array.isArray(value.connect)
        ? value.connect
        : [value];

  const resolved = await Promise.all(
    rawItems.map((item, index) =>
      resolveMediaReferenceId(strapi, item, `${fieldPath}[${index}]`, cache)
    )
  );

  return resolved.filter((item): item is number => typeof item === 'number');
};

const normalizeArticleInputData = async (strapi: Core.Strapi, data: any) => {
  if (!isPlainObject(data)) return data;

  const normalized = { ...data };
  const uploadFileCache = new Map<string, number>();

  if ('cover' in normalized) {
    normalized.cover = await normalizeMultipleMediaField(
      strapi,
      normalized.cover,
      'cover',
      uploadFileCache
    );
    assertArticleCoverLimit(normalized.cover);
  }

  if (Array.isArray(normalized.blocks)) {
    normalized.blocks = await Promise.all(
      normalized.blocks.map(async (block: any, index: number) => {
        if (!isPlainObject(block)) return block;

        const nextBlock = { ...block };

        if (nextBlock.__component === 'shared.media' && 'file' in nextBlock) {
          nextBlock.file = await normalizeSingleMediaField(
            strapi,
            nextBlock.file,
            `blocks[${index}].file`,
            uploadFileCache
          );
        }

        if (nextBlock.__component === 'shared.slider' && 'files' in nextBlock) {
          nextBlock.files = await normalizeMultipleMediaField(
            strapi,
            nextBlock.files,
            `blocks[${index}].files`,
            uploadFileCache
          );
        }

        return nextBlock;
      })
    );
  }

  return normalized;
};

const buildArticleDetail = async (strapi: Core.Strapi, item: any, currentUserId?: number) => {
  const text = typeof item?.text === 'string' ? item.text : '';
  const cover = item?.cover ?? null;
  const author = item?.author ?? null;
  const authorUserId = author?.user?.id;
  const isAnonymous = !!item?.isAnonymous;
  const anonymizeForViewer = shouldAnonymize(
    isAnonymous,
    authorUserId,
    currentUserId,
  );

  const detailAvatarMap = typeof authorUserId === 'number'
    ? await batchResolveEquippedAvatars(strapi, [authorUserId])
    : new Map();
  const equippedDetailImage = typeof authorUserId === 'number'
    ? detailAvatarMap.get(authorUserId)
    : undefined;
  const equippedDetailSmall = equippedDetailImage ? withSmallWebp(equippedDetailImage) : null;
  const authorAvatarSmall = equippedDetailSmall
    ?? (author?.avatar ? withSmallWebp(author.avatar) : null);

  let liked = false;
  let hasGivenDenny = false;
  let favorited = false;
  // 计数直接读取文章上维护的反范式字段（写路径已同步），详情页不再重复聚合。
  const likescount = item?.likescount ?? 0;
  const commentscount = item?.commentscount ?? 0;
  const dennyCount = item?.denny_count ?? 0;
  // 收藏数无反范式字段，按需聚合（单次 count）。
  const favoritesCount = item?.documentId
    ? await strapi.db.query(FAVORITE_UID).count({
        where: { article: { documentId: item.documentId } },
      })
    : 0;
  // 仅查询与当前观众相关、无法反范式的「我是否已点赞 / 已投丁尼 / 已收藏」。匿名访客则跳过。
  if (currentUserId && item?.documentId) {
    const [existing, existingGiven, existingFavorite] = await Promise.all([
      strapi.db.query(LIKE_UID).findOne({
        where: {
          user: { id: currentUserId },
          article: { documentId: item.documentId },
        },
        select: ['id'],
      }),
      strapi.db.query('api::denny-given.denny-given').findOne({
        where: {
          user: { id: currentUserId },
          article: { documentId: item.documentId },
        },
        select: ['id'],
      }),
      strapi.db.query(FAVORITE_UID).findOne({
        where: {
          user: { id: currentUserId },
          article: { documentId: item.documentId },
        },
        select: ['id'],
      }),
    ]);
    liked = !!existing?.id;
    hasGivenDenny = !!existingGiven?.id;
    favorited = !!existingFavorite?.id;
  }

  const renderedAuthor = anonymizeForViewer
    ? {
        ...buildAnonymousAuthor(item?.anonymousSeed, equippedDetailSmall?.url),
      }
    : author
      ? {
          documentId: author?.documentId,
          name: author?.name,
          avatar: authorAvatarSmall,
          level: author?.user?.level ?? null,
        }
      : null;

  const base: Record<string, unknown> = {
    documentId: item?.documentId,
    title: item?.title,
    text,
    cover,
    views: item?.views ?? 0,
    likesCount: likescount,
    commentsCount: commentscount,
    liked,
    favorited,
    favoritesCount,
    dennyCount,
    hasGivenDenny,
    isAnonymous,
    createdAt: item?.createdAt,
    updatedAt: item?.updatedAt,
    author: renderedAuthor,
    category: serializeCategory(item?.category),
  };

  // 非匿名帖额外返回编辑相关字段
  if (!anonymizeForViewer) {
    base.editorState = item?.editorState ?? null;
    base.publishedAt = item?.publishedAt ?? null;
  }

  return base;
};

const findAuthorByUser = async (strapi: Core.Strapi, userId: number) => {
  return strapi.db.query('api::author.author').findOne({
    where: { user: userId },
  });
};

const buildDraftPublicationState = async (strapi: Core.Strapi, draftItems: Record<string, unknown>[]) => {
  const documentIds = (draftItems || [])
    .map((item: any) => item?.documentId)
    .filter((item: any) => typeof item === 'string' && item);

  const publishedVersions = documentIds.length
    ? await getArticleDocuments(strapi).findMany({
        status: 'published',
        fields: ['documentId'],
        filters: {
          documentId: {
            $in: documentIds,
          },
        },
      })
    : [];

  return new Set(
    (publishedVersions || [])
      .map((item: any) => item?.documentId)
      .filter((item: any) => typeof item === 'string' && item)
  );
};

const buildArticleListItems = async (
  strapi: Core.Strapi,
  items: Record<string, unknown>[],
  viewerUserId: number | null,
  extra?: (item: any) => Record<string, unknown>
) => {
  // 所有作者的 user ID 都参与批量解析，以便匿名帖也能展示装备的系统头像。
  const userIds = [...new Set(
    items
      .map((item: any) => item?.author?.user?.id)
      .filter((id: unknown): id is number => typeof id === 'number')
  )];
  const avatarMap = await batchResolveEquippedAvatars(strapi, userIds);
  return items.map((item: any) => ({
    ...buildArticleListItem(item, avatarMap, viewerUserId),
    ...(extra ? extra(item) : {}),
  }));
};

const buildArticleListItem = (
  item: any,
  avatarMap: Map<number, any> | undefined,
  viewerUserId: number | null,
) => {
  const coverList = Array.isArray(item?.cover)
    ? item.cover
    : item?.cover
      ? [item.cover]
      : [];
  const cover = coverList[0] ?? null;
  const author = item?.author ?? null;
  const coverSmall = cover ? withSmallWebp(cover) : null;
  const isAnonymous = !!item?.isAnonymous;
  const anonymizeForViewer = shouldAnonymize(
    isAnonymous,
    author?.user?.id,
    viewerUserId,
  );
  const equippedImage = typeof author?.user?.id === 'number'
    ? avatarMap?.get(author.user.id)
    : undefined;
  const equippedSmall = equippedImage ? withSmallWebp(equippedImage) : null;
  const authorAvatarSmall = equippedSmall
    ?? (author?.avatar ? withSmallWebp(author.avatar) : null);

  const renderedAuthor = anonymizeForViewer
    ? {
        ...buildAnonymousAuthor(item?.anonymousSeed, equippedSmall?.url),
      }
    : author
      ? {
          documentId: author?.documentId,
          name: author?.name,
          avatar: authorAvatarSmall?.url ?? null,
        }
      : null;

  // Note: body text is intentionally omitted. Home / profile / search
  // cards no longer render an excerpt, so we don't transmit it.
  return {
    documentId: item?.documentId,
    title: item?.title,
    cover: coverSmall?.url ?? null,
    coverWidth: cover?.width ?? null,
    coverHeight: cover?.height ?? null,
    views: item?.views ?? 0,
    isAnonymous,
    author: renderedAuthor,
    category: serializeCategory(item?.category),
  };
};

export default factories.createCoreController(
  ARTICLE_UID,
  ({ strapi }) => ({
    async create(ctx) {
      await this.validateQuery(ctx);
      const sanitizedQuery = await this.sanitizeQuery(ctx);
      const requestedStatus =
        sanitizedQuery?.status === 'draft' || sanitizedQuery?.status === 'published'
          ? sanitizedQuery.status
          : 'published';

      const { body = {} } = ctx.request;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.data) {
        return ctx.badRequest('Missing "data" payload in the request body');
      }

      // Extract author relation before validation (Strapi v5 rejects relation keys in validateInput)
      const authorPayload = body.data.author;
      const categoryPayload = body.data.category;
      const dataForValidation = { ...body.data };
      delete dataForValidation.author;
      // category 是关系字段，同样需在 validateInput 前剥离，校验后再以 documentId 注入。
      delete dataForValidation.category;
      // 永远不信任客户端提供的 anonymousSeed，匿名种子完全由服务端生成。
      delete dataForValidation.anonymousSeed;

      await this.validateInput(dataForValidation, ctx);
      const sanitizedInputData = await this.sanitizeInput(dataForValidation, ctx);
      const normalizedInputData = await normalizeArticleInputData(strapi, sanitizedInputData);

      // Re-inject author (already verified by is-author-self policy)
      if (authorPayload) {
        normalizedInputData.author = authorPayload;
      }

      // 匿名标记：仅当客户端明确为 true 时持久化匿名种子。
      if (normalizedInputData.isAnonymous === true) {
        normalizedInputData.anonymousSeed = generateAnonymousSeed();
      } else if (normalizedInputData.isAnonymous === false) {
        // 显式 false 时清空种子，避免残留旧值。
        normalizedInputData.anonymousSeed = null;
      }

      // 首次发布时设置 bumpedAt（Discourse 风格：仅在有意义的新活动时更新）
      if (requestedStatus === 'published') {
        normalizedInputData.bumpedAt = new Date().toISOString();
      }

      // 分区：仅当用户传入有效且已上架的频道时写入；未传/非法则不写（不兜底）。
      const createCategory = await resolveActiveCategory(strapi, categoryPayload);
      if (createCategory) {
        // 仅管理员分区：非管理员禁止在该分区发帖。
        if (createCategory.adminOnly === true && ctx.state?.user?.isAdmin !== true) {
          return ctx.forbidden('Only administrators can post in this category');
        }
        normalizedInputData.category = { documentId: createCategory.documentId };
      }

      const entity = await getArticleDocuments(strapi).create({
        ...sanitizedQuery,
        data: normalizedInputData,
        status: requestedStatus,
      });

      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      ctx.status = 201;
      return this.transformResponse(sanitizedEntity);
    },

    async update(ctx) {
      const { id } = ctx.params;

      await this.validateQuery(ctx);
      const sanitizedQuery = await this.sanitizeQuery(ctx);
      const requestedStatus =
        sanitizedQuery?.status === 'draft' || sanitizedQuery?.status === 'published'
          ? sanitizedQuery.status
          : 'published';

      const { body = {} } = ctx.request;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.data) {
        return ctx.badRequest('Missing "data" payload in the request body');
      }

      // Strip author before validation (Strapi v5 rejects relation keys)
      const hasCategoryKey =
        isPlainObject(body.data) && 'category' in (body.data as Record<string, unknown>);
      const categoryPayload = (body.data as Record<string, unknown>)?.category;
      const dataForUpdateValidation = { ...body.data };
      delete dataForUpdateValidation.author;
      delete dataForUpdateValidation.category;
      // 永远不信任客户端提供的 anonymousSeed。
      delete dataForUpdateValidation.anonymousSeed;

      await this.validateInput(dataForUpdateValidation, ctx);
      const sanitizedInputData = await this.sanitizeInput(dataForUpdateValidation, ctx);

      const normalizedInputData = await normalizeArticleInputData(strapi, sanitizedInputData);

      // 处理匿名标记变更：保持现有 seed 以便切换可逆；首次启用时生成。
      if (normalizedInputData.isAnonymous === true) {
        const existing = await strapi.db.query(ARTICLE_UID).findOne({
          where: { documentId: id },
          select: ['anonymousSeed'],
        });
        normalizedInputData.anonymousSeed = existing?.anonymousSeed || generateAnonymousSeed();
      } else if (normalizedInputData.isAnonymous === false) {
        normalizedInputData.anonymousSeed = null;
      }

      // 仅当请求显式携带 category 字段、且解析为有效已上架频道时才改动分区；
      // 非法/为空则不改（不兜底）。
      if (hasCategoryKey) {
        const updateCategory = await resolveActiveCategory(strapi, categoryPayload);
        if (updateCategory) {
          // 仅管理员分区：非管理员禁止把帖子改到该分区。
          if (updateCategory.adminOnly === true && ctx.state?.user?.isAdmin !== true) {
            return ctx.forbidden('Only administrators can post in this category');
          }
          normalizedInputData.category = { documentId: updateCategory.documentId };
        }
      }

      const entity = await getArticleDocuments(strapi).update({
        ...sanitizedQuery,
        documentId: id,
        data: normalizedInputData,
        status: requestedStatus,
      });

      const sanitizedEntity = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitizedEntity);
    },

    async listLite(ctx) {
      const { start: safeStart, limit: safeLimit } = parsePagination(
        ctx.query?.start,
        ctx.query?.limit
      );

      const categorySlug = parseCategorySlug(ctx.query?.category);
      const categoryFilters = categorySlug
        ? { category: { slug: categorySlug } }
        : undefined;

      const feed = parseFeed(ctx.query?.feed);
      const viewerUserId = ctx.state?.user?.id ?? null;

      const LIST_FIELDS: any = ['documentId', 'title', 'views', 'isAnonymous'];
      const LIST_POPULATE: any = {
        author: {
          fields: ['documentId', 'name'],
          populate: {
            avatar: { fields: ['url'] },
            user: { fields: ['id'] },
          },
        },
        cover: { fields: ['url', 'width', 'height'] },
        category: { fields: ['name', 'slug'] },
      };

      const buildPaginationMeta = (total: number) => ({
        start: safeStart,
        limit: safeLimit,
        total,
        pageCount: safeLimit > 0 ? Math.ceil(total / safeLimit) : 0,
      });

      const sendEmpty = () =>
        ctx.send({ data: [], meta: { pagination: buildPaginationMeta(0) } });

      // 关注 / 收藏 feed 需登录；未登录直接返回空列表（前端据此引导登录）。
      if ((feed === 'following' || feed === 'favorites') && !viewerUserId) {
        return sendEmpty();
      }

      // ── 收藏 feed：按收藏时间倒序分页，再按序补齐文章卡片。 ──
      if (feed === 'favorites') {
        const favWhere = { user: { id: viewerUserId } };
        const [favRows, total] = await Promise.all([
          strapi.db.query(FAVORITE_UID).findMany({
            offset: safeStart,
            limit: safeLimit,
            orderBy: { createdAt: 'desc' },
            where: favWhere,
            select: ['id'],
            populate: { article: { select: ['documentId'] } },
          }),
          strapi.db.query(FAVORITE_UID).count({ where: favWhere }),
        ]);

        const orderedIds = (favRows || [])
          .map((row: any) => row?.article?.documentId)
          .filter((id: unknown): id is string => typeof id === 'string' && !!id);

        if (!orderedIds.length) {
          return ctx.send({ data: [], meta: { pagination: buildPaginationMeta(total) } });
        }

        const found = await getArticleDocuments(strapi).findMany({
          status: 'published',
          filters: { documentId: { $in: orderedIds } },
          fields: LIST_FIELDS,
          populate: LIST_POPULATE,
          limit: orderedIds.length,
        });
        const byId = new Map((found || []).map((it: any) => [it.documentId, it]));
        const data = orderedIds
          .map((id) => byId.get(id))
          .filter((it: any) => Boolean(it));

        await attachAnonymousSeeds(strapi, data);
        const liteData = await buildArticleListItems(strapi, data, viewerUserId);
        return ctx.send({ data: liteData, meta: { pagination: buildPaginationMeta(total) } });
      }

      // ── 关注 feed：取当前用户关注的作者集合，过滤文章。 ──
      let feedFilters: Record<string, unknown> | undefined;
      if (feed === 'following') {
        const follows = await strapi.db.query(FOLLOW_UID).findMany({
          where: { follower: { id: viewerUserId } },
          select: ['id'],
          populate: { following: { select: ['id'] } },
          limit: MAX_FOLLOWING_AUTHORS,
        });
        const authorIds = Array.from(
          new Set(
            (follows || [])
              .map((f: any) => f?.following?.id)
              .filter((id: unknown): id is number => typeof id === 'number')
          )
        );
        if (!authorIds.length) return sendEmpty();
        feedFilters = { author: { id: { $in: authorIds } } };
      }

      const combinedFilters = {
        ...(categoryFilters || {}),
        ...(feedFilters || {}),
      };
      const hasFilters = Object.keys(combinedFilters).length > 0;

      const listParams: any = {
        status: 'published',
        start: safeStart,
        limit: safeLimit,
        sort: ['bumpedAt:desc'],
        fields: LIST_FIELDS,
        ...(hasFilters ? { filters: combinedFilters } : {}),
        populate: LIST_POPULATE,
      };

      const [data, total] = await Promise.all([
        getArticleDocuments(strapi).findMany(listParams),
        getArticleDocuments(strapi).count({
          status: 'published',
          ...(hasFilters ? { filters: combinedFilters } : {}),
        }),
      ]);
      await attachAnonymousSeeds(strapi, data || []);

      const liteData = await buildArticleListItems(strapi, data || [], viewerUserId);

      ctx.send({
        data: liteData,
        meta: { pagination: buildPaginationMeta(total) },
      });
    },

    async detailLite(ctx) {
      const documentIdRaw = ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';
      if (!documentId) return ctx.badRequest('Missing documentId');

      const detailParams: any = {
        status: 'published',
        documentId,
        fields: ['documentId', 'title', 'text', 'editorState', 'views', 'commentscount', 'likescount', 'denny_count', 'createdAt', 'updatedAt', 'isAnonymous'],
        populate: {
          author: {
            fields: ['documentId', 'name'],
            populate: {
              avatar: { fields: ['url', 'width', 'height'] },
              user: { fields: ['id', 'level'] },
            },
          },
          cover: { fields: ['url', 'width', 'height'] },
          category: { fields: ['name', 'slug'] },
        },
      };

      const item: any = await getArticleDocuments(strapi).findOne(detailParams);
      if (!item) return ctx.notFound();
      await attachAnonymousSeeds(strapi, item);

      const user = ctx.state?.user;

      ctx.send({
        data: await buildArticleDetail(strapi, item, user?.id),
      });
    },

    async searchLite(ctx) {
      const qRaw = ctx.query?.q;
      const startRaw = ctx.query?.start;
      const limitRaw = ctx.query?.limit;

      const q = typeof qRaw === 'string' ? qRaw.trim() : '';
      const categorySlug = parseCategorySlug(ctx.query?.category);
      const { start: safeStart, limit: safeLimit } = parsePagination(
        startRaw,
        limitRaw
      );

      // 单字查询也放行：Meilisearch 对单个中文字也能正常分词检索，
      // 与 /articles/suggest 的行为保持一致（联想有结果而搜索为空会很奇怪）。
      if (!q) {
        ctx.send({
          data: [],
          meta: {
            pagination: {
              start: safeStart,
              limit: safeLimit,
              total: 0,
              pageCount: 0,
            },
          },
        });
        return;
      }

      const articleFields: any = ['documentId', 'title', 'views', 'isAnonymous'];
      const articlePopulate: any = {
        author: {
          fields: ['documentId', 'name'],
          populate: {
            avatar: { fields: ['url'] },
            user: { fields: ['id'] },
          },
        },
        cover: { fields: ['url', 'width', 'height'] },
        category: { fields: ['name', 'slug'] },
      };

      let data: any[] | null = null;
      let total = 0;

      // 优先 Meilisearch（错别容错 / 中文分词 / 相关性排序），失败回退 MySQL。
      try {
        const result = await searchArticleIndex(strapi, q, {
          start: safeStart,
          limit: safeLimit,
          categorySlug,
        });
        total = result.total;
        const orderedIds = result.hits.map((h) => h.documentId);
        if (orderedIds.length > 0) {
          const found = await getArticleDocuments(strapi).findMany({
            status: 'published',
            filters: { documentId: { $in: orderedIds } },
            fields: articleFields,
            populate: articlePopulate,
            limit: orderedIds.length,
          });
          const byId = new Map((found || []).map((it: any) => [it.documentId, it]));
          data = orderedIds
            .map((id) => byId.get(id))
            .filter((it: any) => Boolean(it));
        } else {
          data = [];
        }
      } catch (err) {
        strapi.log.warn(
          `Meilisearch search failed, falling back to MySQL: ${err instanceof Error ? err.message : String(err)}`,
        );
        data = null;
      }

      if (data === null && q.length < 2) {
        // MySQL 回退路径不接单字查询：全文索引最小词长不支持，
        // 而单字 LIKE '%x%' 在大表上是全表扫描。
        data = [];
        total = 0;
      }

      if (data === null) {
        const knex = strapi.db.connection;
        let matchedIds: number[] = [];
        try {
          const ftRows = await knex('articles')
            .select('id')
            .whereNotNull('published_at')
            .whereRaw('MATCH(title, text) AGAINST(? IN BOOLEAN MODE)', [q]);
          matchedIds = ftRows.map((r: any) => r.id);
        } catch {
          matchedIds = [];
        }

        let where: any;
        if (matchedIds.length > 0) {
          where = { id: { $in: matchedIds } };
        } else {
          where = {
            $or: [
              { title: { $contains: q } },
              { text: { $contains: q } },
            ],
          };
        }

        // 限定分区：与全文/模糊条件取交集。
        if (categorySlug) {
          where = { $and: [where, { category: { slug: categorySlug } }] };
        }

        const searchParams: any = {
          status: 'published',
          start: safeStart,
          limit: safeLimit,
          sort: ['updatedAt:desc'],
          filters: where,
          // `text` is filtered at SQL level via MATCH / $contains; we don't
          // need the column in the response payload.
          fields: articleFields,
          populate: articlePopulate,
        };

        const [sqlData, sqlTotal] = await Promise.all([
          getArticleDocuments(strapi).findMany(searchParams),
          getArticleDocuments(strapi).count({ status: 'published', filters: where }),
        ]);
        data = sqlData || [];
        total = sqlTotal;
      }

      await attachAnonymousSeeds(strapi, data || []);

      const viewerUserId = ctx.state?.user?.id ?? null;
      const liteData = await buildArticleListItems(strapi, data || [], viewerUserId);

      ctx.send({
        data: liteData,
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
     * 轻量联想接口（GET /articles/suggest）：边输入边搜的实时推荐。
     * Meilisearch 命中后回查数据库轻量校验（发布状态 / 匿名态以 DB 为准）。
     */
    async suggestLite(ctx) {
      const qRaw = ctx.query?.q;
      const q = typeof qRaw === 'string' ? qRaw.trim() : '';
      const categorySlug = parseCategorySlug(ctx.query?.category);
      const limitRaw = Number.parseInt(String(ctx.query?.limit ?? ''), 10);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(limitRaw, 1), 10)
        : 8;

      if (!q) {
        ctx.send({ data: [], meta: { total: 0 } });
        return;
      }

      try {
        const result = await searchArticleIndex(strapi, q, {
          start: 0,
          limit,
          categorySlug,
          highlight: true,
        });

        // 回查数据库校验：过滤已删除 / 未发布的索引残留，并以 DB 为准
        // 取匿名状态与作者名，避免索引滞后导致泄露身份（最终一致性窗口）。
        const orderedIds = result.hits.map((h) => h.documentId);
        const verified = orderedIds.length > 0
          ? await getArticleDocuments(strapi).findMany({
              status: 'published',
              filters: { documentId: { $in: orderedIds } },
              fields: ['documentId', 'isAnonymous'],
              populate: {
                author: { fields: ['name'] },
                category: { fields: ['name', 'slug'] },
              },
              limit: orderedIds.length,
            })
          : [];
        const verifiedById = new Map(
          (verified || []).map((it: any) => [it.documentId, it]),
        );

        ctx.send({
          data: result.hits
            .filter((h) => verifiedById.has(h.documentId))
            .map((h) => {
              const doc: any = verifiedById.get(h.documentId);
              const isAnonymous = doc?.isAnonymous === true;
              return {
                documentId: h.documentId,
                title: h.title,
                titleHighlighted: h.titleHighlighted ?? h.title,
                excerpt: h.excerpt ?? '',
                authorName: isAnonymous ? null : (doc?.author?.name ?? null),
                categoryName: doc?.category?.name ?? null,
                categorySlug: doc?.category?.slug ?? null,
                isAnonymous,
              };
            }),
          meta: { total: result.total },
        });
      } catch (err) {
        strapi.log.warn(
          `Meilisearch suggest failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        ctx.send({ data: [], meta: { total: 0 } });
      }
    },

    async myListLite(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const { start: safeStart, limit: safeLimit } = parsePagination(
        ctx.query?.start,
        ctx.query?.limit
      );

      const author = await findAuthorByUser(strapi, user.id);

      if (!author?.id) {
        ctx.send({
          data: [],
          meta: {
            pagination: {
              start: safeStart,
              limit: safeLimit,
              total: 0,
              pageCount: 0,
            },
          },
        });
        return;
      }

      const where = {
        author: { id: author.id },
      };

      const [data, total] = await Promise.all([
        getArticleDocuments(strapi).findMany({
          status: 'draft',
          start: safeStart,
          limit: safeLimit,
          sort: ['updatedAt:desc'],
          filters: where,
          fields: ['documentId', 'title', 'views', 'commentscount', 'likescount', 'createdAt', 'updatedAt', 'publishedAt', 'isAnonymous'],
          populate: {
            author: {
              fields: ['documentId', 'name'],
              populate: {
                avatar: { fields: ['url', 'width', 'height'] },
                user: { fields: ['id'] },
              },
            },
            cover: { fields: ['url', 'width', 'height'] },
            category: { fields: ['name', 'slug'] },
          },
        }),
        getArticleDocuments(strapi).count({ status: 'draft', filters: where }),
      ]);
      await attachAnonymousSeeds(strapi, data || []);

      const publishedSet = await buildDraftPublicationState(strapi, data || []);

      // 过滤掉已发布的匿名帖（不可编辑）；未发布的匿名草稿保留
      const filtered = (data || []).filter((item: any) =>
        !item?.isAnonymous || !publishedSet.has(item?.documentId)
      );
      const list = await buildArticleListItems(strapi, filtered, user.id, (item: any) => ({
        hasPublishedVersion: publishedSet.has(item?.documentId),
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

    async myDraftsOnlyLite(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const { start: safeStart, limit: safeLimit } = parsePagination(
        ctx.query?.start,
        ctx.query?.limit
      );

      const author = await findAuthorByUser(strapi, user.id);

      if (!author?.id) {
        ctx.send({
          data: [],
          meta: {
            pagination: {
              start: safeStart,
              limit: safeLimit,
              total: 0,
              pageCount: 0,
            },
          },
        });
        return;
      }

      const where = {
        author: { id: author.id },
      };

      const publishedItems = await getArticleDocuments(strapi).findMany({
        status: 'published',
        filters: where,
        fields: ['documentId'],
      });
      const publishedDocIds = (publishedItems || [])
        .map((i: any) => i?.documentId)
        .filter(Boolean);

      const draftWhere = publishedDocIds.length > 0
        ? { ...where, documentId: { $notIn: publishedDocIds } }
        : where;

      const [draftItems, total] = await Promise.all([
        getArticleDocuments(strapi).findMany({
          status: 'draft',
          sort: ['updatedAt:desc'],
          start: safeStart,
          limit: safeLimit,
          filters: draftWhere,
          fields: ['documentId', 'title', 'text', 'createdAt', 'updatedAt'],
        }),
        getArticleDocuments(strapi).count({ status: 'draft', filters: draftWhere }),
      ]);

      const PREVIEW_LIMIT = 80;
      ctx.send({
        data: (draftItems || []).map((item: any) => {
          const rawText = typeof item?.text === 'string' ? item.text : '';
          return {
            documentId: item?.documentId,
            title: item?.title ?? '',
            text: rawText.length > PREVIEW_LIMIT
              ? rawText.slice(0, PREVIEW_LIMIT)
              : rawText,
            createdAt: item?.createdAt,
            updatedAt: item?.updatedAt,
          };
        }),
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

    async myPublishedListLite(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const { start: safeStart, limit: safeLimit } = parsePagination(
        ctx.query?.start,
        ctx.query?.limit
      );

      const author = await findAuthorByUser(strapi, user.id);

      if (!author?.id) {
        ctx.send({
          data: [],
          meta: {
            pagination: {
              start: safeStart,
              limit: safeLimit,
              total: 0,
              pageCount: 0,
            },
          },
        });
        return;
      }

      const where = {
        author: { id: author.id },
        $or: [{ isAnonymous: { $null: true } }, { isAnonymous: false }],
      };

      const [data, total] = await Promise.all([
        getArticleDocuments(strapi).findMany({
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
            'publishedAt',
            'isAnonymous',
          ],
          populate: {
            author: {
              fields: ['documentId', 'name'],
              populate: {
                avatar: { fields: ['url', 'width', 'height'] },
                user: { fields: ['id'] },
              },
            },
            cover: { fields: ['url', 'width', 'height'] },
            category: { fields: ['name', 'slug'] },
          },
        }),
        getArticleDocuments(strapi).count({ status: 'published', filters: where }),
      ]);
      await attachAnonymousSeeds(strapi, data || []);

      ctx.send({
        data: await buildArticleListItems(strapi, data || [], user.id, () => ({
          hasPublishedVersion: true,
        })),
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

    async myDetailLite(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const documentIdRaw = ctx.params?.id || ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const [draftItem, publishedCount] = await Promise.all([
        getArticleDocuments(strapi).findOne({
          status: 'draft',
          documentId,
          fields: [
            'documentId',
            'title',
            'text',
            'editorState',
            'createdAt',
            'updatedAt',
            'isAnonymous',
          ],
          populate: {
            cover: { fields: ['url', 'width', 'height'] },
            category: { fields: ['name', 'slug'] },
          },
        }),
        getArticleDocuments(strapi).count({
          status: 'published',
          filters: { documentId },
        }),
      ]);

      if (!draftItem) return ctx.notFound();

      const coverList = Array.isArray((draftItem)?.cover)
        ? (draftItem).cover
        : (draftItem)?.cover
          ? [(draftItem).cover]
          : [];

      ctx.send({
        data: {
          documentId: (draftItem)?.documentId,
          title: (draftItem)?.title ?? '',
          text: (draftItem)?.text ?? '',
          editorState: (draftItem)?.editorState ?? null,
          cover: coverList.map((c: any) => ({
            documentId: c?.documentId,
            url: c?.url,
            width: c?.width,
            height: c?.height,
          })),
          createdAt: (draftItem)?.createdAt,
          updatedAt: (draftItem)?.updatedAt,
          isAnonymous: !!(draftItem)?.isAnonymous,
          category: serializeCategory((draftItem)?.category),
          hasPublishedVersion: publishedCount > 0,
        },
      });
    },

    async publishMine(ctx) {
      const documentIdRaw = ctx.params?.id || ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const draftItem = await getArticleDocuments(strapi).findOne({
        status: 'draft',
        documentId,
        populate: {
          cover: { fields: ['id'] },
        },
      });
      if (!draftItem) return ctx.notFound();
      assertArticleCoverLimit((draftItem).cover);

      const result = await getArticleDocuments(strapi).publish({
        documentId,
      });

      const publishedItem = Array.isArray(result) ? result[0] : result;
      if (!publishedItem?.documentId) return ctx.notFound();

      // 草稿转发布：设置 bumpedAt 使文章出现在推流顶部
      try {
        await strapi.db.query(ARTICLE_UID).updateMany({
          where: { documentId },
          data: { bumpedAt: new Date().toISOString() },
        });
      } catch (err) {
        strapi.log.warn(`[bumpedAt] failed to bump on publish: ${err}`);
      }

      ctx.send({
        data: {
          documentId: publishedItem.documentId,
          publishedAt: publishedItem.publishedAt ?? null,
          hasPublishedVersion: true,
        },
      });
    },

    async unpublishMine(ctx) {
      const documentIdRaw = ctx.params?.id || ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const discardDraft = !!ctx.request?.body?.discardDraft;

      if (discardDraft) {
        await getArticleDocuments(strapi).discardDraft({
          documentId,
        });
      }

      const result = await getArticleDocuments(strapi).unpublish({
        documentId,
      });

      const unpublishedItem = Array.isArray(result?.entries)
        ? result.entries[0]
        : result;

      ctx.send({
        data: {
          documentId,
          unpublishedAt: new Date().toISOString(),
          hasPublishedVersion: false,
          draftPreserved: !discardDraft,
          locale: (unpublishedItem as { locale?: string })?.locale ?? null,
        },
      });
    },

    async deleteMine(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const documentIdRaw = ctx.params?.id || ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      // 验证帖子存在且属于当前用户
      const author = await findAuthorByUser(strapi, user.id);
      if (!author?.id) return ctx.notFound('Author not found');

      const article = await strapi.db.query(ARTICLE_UID).findOne({
        where: { documentId },
        select: ['id', 'documentId'],
        populate: { author: { select: ['id'] } },
      });

      if (!article) return ctx.notFound('Article not found');
      if (article.author?.id !== author.id) {
        return ctx.forbidden('You can only delete your own articles');
      }

      const publishedItem = await getArticleDocuments(strapi).findOne({
        status: 'published',
        documentId,
        fields: ['documentId'],
      });
      const hasPublishedVersion = !!publishedItem?.documentId;

      let deductResult = null as Awaited<ReturnType<typeof deductDenny>> | null;
      if (hasPublishedVersion) {
        // 仅删除已发布帖子扣 100 丁尼；纯草稿删除免费
        deductResult = await deductDenny(
          strapi,
          user.id,
          100,
          'spend_delete_post',
          `删除帖子: ${documentId}`,
          'api::article.article',
          documentId,
        );

        if (!deductResult) {
          return ctx.internalServerError('扣除丁尼失败，请稍后重试');
        }

        if (!deductResult.success) {
          return ctx.badRequest('丁尼余额不足');
        }
      }

      try {
        await getArticleDocuments(strapi).delete({ documentId });

        ctx.send({
          success: true,
          message: hasPublishedVersion ? 'Article deleted successfully' : 'Draft deleted successfully',
          ...(deductResult?.success ? { newBalance: deductResult.newBalance } : {}),
        });
      } catch (err) {
        if (hasPublishedVersion && deductResult?.success) {
          strapi.log.error('[denny] Delete article failed, refunding Denny:', err);
          const { addDenny } = await import('../../../utils/denny');
          await addDenny(
            strapi,
            user.id,
            100,
            'refund',
            `删除帖子失败退款: ${documentId}`,
            'api::article.article',
            `refund:${documentId}`,
          );
        } else {
          strapi.log.error('[article] Delete draft failed:', err);
        }
        return ctx.internalServerError(
          hasPublishedVersion ? '删除帖子失败，已退还丁尼' : '删除草稿失败',
        );
      }
    },

    async incrementView(ctx) {
      const documentIdRaw = ctx.params?.documentId;
      const documentId =
        typeof documentIdRaw === 'string' ? documentIdRaw.trim() : '';

      if (!documentId) return ctx.badRequest('Missing documentId');

      const redis = getRedis();

      const clientKey = ctx.state?.user?.id
        ? `u:${ctx.state.user.id}`
        : `ip:${ctx.request?.ip || 'unknown'}`;

      // Global view rate limit: max 30 view counts per IP per minute
      const globalKey = `view_gl:${clientKey}`;
      try {
        const globalCount = await redis.incr(globalKey);
        if (globalCount === 1) await redis.expire(globalKey, 60);
        if (globalCount > 30) {
          ctx.send({ ok: true });
          return;
        }
      } catch { /* fail-open */ }

      const viewKey = `view_cd:${clientKey}:${documentId}`;
      let exists = 0;
      try {
        exists = await redis.exists(viewKey);
      } catch { /* fail-open: redis not available */ }
      if (exists) {
        ctx.send({ ok: true });
        return;
      }

      const article = await strapi.db.query(ARTICLE_UID).findOne({
        where: {
          documentId,
          publishedAt: {
            $notNull: true,
          },
        },
        select: ['id', 'views'],
      });

      if (!article?.id) return ctx.notFound();

      await strapi.db.connection('articles')
        .where({ id: article.id })
        .increment('views', 1);

      const updatedArticle = await strapi.db.query(ARTICLE_UID).findOne({
        where: { id: article.id },
        select: ['views'],
      });

      try {
        await redis.setex(viewKey, VIEW_COOLDOWN_SEC, '1');
      } catch { /* fail-open: redis not available */ }
      ctx.send({
        ok: true,
        counted: true,
        views: updatedArticle?.views ?? (article.views ?? 0) + 1,
      });
    },

  })
);
