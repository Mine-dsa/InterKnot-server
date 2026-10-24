import type { Core } from '@strapi/strapi';
/**
 * comment controller
 */

import { factories } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { parsePagination, withSmallWebp, batchResolveEquippedAvatars } from '../../../utils/common';
import {
  buildAnonymousAuthor,
  generateAnonymousSeed,
  shouldAnonymize,
} from '../../../utils/anonymous';

const COMMENT_UID = 'api::comment.comment';
const { ApplicationError } = errors;

const getCommentDocuments = (strapi: Core.Strapi) => strapi.documents(COMMENT_UID);

export default factories.createCoreController(
  COMMENT_UID,
  ({ strapi }) => ({
    /**
     * Custom create – bypasses core validateInput which throws
     * "Invalid key article" due to restrictedRelations checks.
     */
    async create(ctx) {
      const user = ctx.state?.user;
      if (!user?.id) return ctx.unauthorized();

      const { body = {} } = ctx.request;
      const data = body?.data;
      if (!data || typeof data !== 'object') {
        return ctx.badRequest('Missing "data" payload');
      }

      const content = typeof data.content === 'string' ? data.content.trim() : '';
      if (!content) {
        return ctx.badRequest('content is required');
      }
      if (content.length > 2000) {
        return ctx.badRequest('content exceeds 2000 characters');
      }

      // ── resolve author ──────────────────────────────
      const rawAuthor = data.author;
      if (!rawAuthor) return ctx.badRequest('author is required');

      let authorDocumentId: string | undefined;
      if (typeof rawAuthor === 'string') {
        authorDocumentId = rawAuthor;
      } else if (typeof rawAuthor === 'object' && rawAuthor !== null) {
        authorDocumentId = rawAuthor.documentId;
        if (!authorDocumentId && Array.isArray(rawAuthor.connect)) {
          const first = rawAuthor.connect[0];
          authorDocumentId = typeof first === 'string' ? first : first?.documentId;
        }
      }
      if (!authorDocumentId) return ctx.badRequest('Invalid author');

      const author = await strapi.db.query('api::author.author').findOne({
        where: { documentId: authorDocumentId },
        populate: ['user'],
      });
      if (!author) return ctx.badRequest('Author not found');
      if (author.user?.id !== user.id) return ctx.forbidden('Author does not belong to you');

      // ── resolve article ─────────────────────────────
      const rawArticle = data.article;
      if (!rawArticle) return ctx.badRequest('article is required');

      const articleDocumentId = typeof rawArticle === 'string' ? rawArticle : rawArticle?.documentId;
      if (!articleDocumentId) return ctx.badRequest('Invalid article');

      const article = await strapi.db.query('api::article.article').findOne({
        where: { documentId: articleDocumentId },
        select: ['id', 'documentId'],
      });
      if (!article) return ctx.badRequest('Article not found');

      // ── resolve parent (optional, for replies) ──────
      let parentId: number | undefined;
      const rawParent = data.parent;
      if (rawParent) {
        const parentDocumentId = typeof rawParent === 'string' ? rawParent : rawParent?.documentId;
        if (!parentDocumentId) return ctx.badRequest('Invalid parent');

        const parentComment = await strapi.db.query(COMMENT_UID).findOne({
          where: { documentId: parentDocumentId },
          select: ['id', 'documentId'],
        });
        if (!parentComment) return ctx.badRequest('Parent comment not found');
        parentId = parentComment.id;
      }

      // ── 匿名标记 ────────────────────────────
      // 仅信任客户端提供的 isAnonymous 布尔値；anonymousSeed 始终由服务端生成。
      const isAnonymous = data.isAnonymous === true;
      const anonymousSeed = isAnonymous ? generateAnonymousSeed() : null;

      // ── create comment ──────────────────────────
      const entity = await getCommentDocuments(strapi).create({
        data: {
          content,
          author: author.documentId,
          article: article.documentId,
          isAnonymous,
          anonymousSeed,
          ...(parentId != null ? { parent: parentId } : {}),
        },
      });

      ctx.status = 201;
      ctx.send({
        data: {
          documentId: entity?.documentId,
          content: entity?.content,
          createdAt: entity?.createdAt,
          isAnonymous,
        },
      });
    },

    async listLite(ctx) {
      const articleRaw = ctx.query?.article;
      const startRaw = ctx.query?.start;
      const limitRaw = ctx.query?.limit;

      const articleDocumentId =
        typeof articleRaw === 'string' ? articleRaw.trim() : '';
      if (!articleDocumentId) return ctx.badRequest('Missing article');

      const { start: safeStart, limit: safeLimit } = parsePagination(startRaw, limitRaw);

      // 楼中楼安全上限：避免热帖场景下无界 populate 拖垮列表接口。
      // 正常讨论远低于这两个阈值；超出部分截断（后续可扩展“加载更多楼中楼”）。
      const REPLIES_TOTAL_HARD_CAP = 500; // 本页全部顶层评论的楼中楼总数上限
      const REPLIES_PER_COMMENT_CAP = 100; // 单条顶层评论的楼中楼条数上限

      const where = {
        article: { documentId: articleDocumentId },
        parent: { documentId: { $null: true } },
      };

      // 用 db.query 而不是 entityService.findMany —— anonymousSeed 在 schema 里是
      // private: true，entityService 会校验 fields 时拒掉它。db.query 不走这层。
      const listParams: any = {
        offset: safeStart,
        limit: safeLimit,
        orderBy: { createdAt: 'asc' },
        where,
        select: ['documentId', 'content', 'createdAt', 'likescount', 'isAnonymous', 'anonymousSeed'],
        populate: {
          author: {
            select: ['name', 'documentId'],
            populate: {
              avatar: { select: ['url', 'width', 'height'] },
              user: { select: ['id', 'level', 'isAiAgent', 'username'] },
            },
          },
          // 楼中楼改为独立查询（见下方），populate 中不再无界加载 replies。
        },
      };

      const [rawData, total] = await Promise.all([
        strapi.db.query('api::comment.comment').findMany(listParams),
        strapi.db.query('api::comment.comment').count({ where }),
      ]);

      const data = Array.isArray(rawData) ? rawData : [];

      // ── 楼中楼独立加载（带总量/单楼上限）──────────────────
      const topDocumentIds = data
        .map((item: any) => item?.documentId)
        .filter((id: any): id is string => typeof id === 'string' && !!id);

      const replyRows = topDocumentIds.length
        ? await strapi.db.query(COMMENT_UID).findMany({
            where: { parent: { documentId: { $in: topDocumentIds } } },
            orderBy: { createdAt: 'asc' },
            limit: REPLIES_TOTAL_HARD_CAP,
            select: ['documentId', 'content', 'createdAt', 'likescount', 'isAnonymous', 'anonymousSeed'],
            populate: {
              author: {
                select: ['name', 'documentId'],
                populate: {
                  avatar: { select: ['url', 'width', 'height'] },
                  user: { select: ['id', 'level', 'isAiAgent', 'username'] },
                },
              },
              // 仅用于把楼中楼归组到所属顶层评论（documentId），不递归展开更深层级。
              parent: { select: ['documentId'] },
            },
          })
        : [];

      const repliesByParent = new Map<string, any[]>();
      for (const reply of replyRows || []) {
        const parentDocumentId = reply?.parent?.documentId;
        if (typeof parentDocumentId !== 'string' || !parentDocumentId) continue;
        const bucket = repliesByParent.get(parentDocumentId);
        if (bucket) {
          bucket.push(reply);
        } else {
          repliesByParent.set(parentDocumentId, [reply]);
        }
      }

      // 挂回 item.replies，保持后续序列化逻辑不变；单楼截断到上限。
      for (const item of data) {
        const docId = item?.documentId;
        item.replies = repliesByParent.get(docId)?.slice(0, REPLIES_PER_COMMENT_CAP) ?? [];
      }

      const user = ctx.state?.user;
      const viewerUserId: number | null = user?.id ?? null;

      // Batch-resolve equipped avatars for all authors (including anonymous)
      // 匿名记录也参与解析，以便展示装备的系统头像。
      const allAuthorUserIds: number[] = [];
      for (const item of (data || [])) {
        const uid = item?.author?.user?.id;
        if (typeof uid === 'number') {
          allAuthorUserIds.push(uid);
        }
        if (Array.isArray(item?.replies)) {
          for (const reply of item.replies) {
            const ruid = reply?.author?.user?.id;
            if (typeof ruid === 'number') {
              allAuthorUserIds.push(ruid);
            }
          }
        }
      }
      const equippedAvatarMap = await batchResolveEquippedAvatars(strapi, [...new Set(allAuthorUserIds)]);

      const allCommentDocumentIds: string[] = [];

      for (const item of data) {
        if (typeof item?.documentId === 'string' && item.documentId) {
          allCommentDocumentIds.push(item.documentId);
        }
        if (Array.isArray(item?.replies)) {
          for (const reply of item.replies) {
            if (typeof reply?.documentId === 'string' && reply.documentId) {
              allCommentDocumentIds.push(reply.documentId);
            }
          }
        }
      }

      const uniqueCommentDocumentIds = Array.from(new Set(allCommentDocumentIds));
      let likedSet = new Set<string>();

      if (user?.id && uniqueCommentDocumentIds.length > 0) {
        const likes = await strapi.db.query('api::like.like').findMany({
          where: {
            user: { id: user.id },
            comment: {
              documentId: {
                $in: uniqueCommentDocumentIds,
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
            .filter((id: any) => typeof id === 'string' && id)
        );
      }

      const resolveCommentAvatar = (author: any) => {
        if (!author) return null;
        const uid = author?.user?.id;
        const equipped = typeof uid === 'number' ? equippedAvatarMap.get(uid) : undefined;
        return equipped
          ? withSmallWebp(equipped)
          : author?.avatar ?? null;
      };

      /**
       * 根据匿名标志对评论的作者进行脱敏化。
       * 拥有者本人始终可见真实作者以便后台管理/编辑。
       */
      const renderCommentAuthor = (node: any) => {
        if (!node?.author) return null;
        const ownerUid = node.author?.user?.id;
        if (shouldAnonymize(node?.isAnonymous, ownerUid, viewerUserId)) {
          const equipped = typeof ownerUid === 'number' ? equippedAvatarMap.get(ownerUid) : undefined;
          const equippedUrl = equipped ? withSmallWebp(equipped)?.url ?? null : null;
          return { ...buildAnonymousAuthor(node?.anonymousSeed, equippedUrl) };
        }
        return {
          id: node.author?.id ?? null,
          documentId: node.author?.documentId ?? null,
          name: node.author?.name,
          login: node.author?.user?.username ?? null,
          avatar: resolveCommentAvatar(node.author),
          level: node.author?.user?.level ?? null,
          isAiAgent: node.author?.user?.isAiAgent === true,
        };
      };

      const liteData = data.map((item: any) => ({
        documentId: item?.documentId,
        content: item?.content,
        createdAt: item?.createdAt,
        likesCount: item?.likescount ?? 0,
        liked: likedSet.has(item?.documentId),
        isAnonymous: !!item?.isAnonymous,
        author: renderCommentAuthor(item),
        replies: Array.isArray(item?.replies)
          ? item.replies.map((reply: any) => ({
              documentId: reply?.documentId,
              content: reply?.content,
              createdAt: reply?.createdAt,
              likesCount: reply?.likescount ?? 0,
              liked: likedSet.has(reply?.documentId),
              isAnonymous: !!reply?.isAnonymous,
              author: renderCommentAuthor(reply),
            }))
          : [],
      }));

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
  })
);
