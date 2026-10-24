import { withSmallWebp } from '../../../utils/common';
import { deductDenny, addDenny } from '../../../utils/denny';

const AUTHOR_UID = 'api::author.author';
const ARTICLE_UID = 'api::article.article';
const USER_UID = 'plugin::users-permissions.user';
const NAME_MIN_LENGTH = 3;
const NAME_MAX_LENGTH = 20;
const BIO_MAX_LENGTH = 100;
const PROFILE_PINNED_MAX = 6;
const CANDIDATE_DEFAULT_LIMIT = 50;
const CANDIDATE_MAX_LIMIT = 100;

const normalizePinnedInput = (raw: unknown): string[] | null | 'invalid' => {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return 'invalid';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return 'invalid';
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
};

export default {
  async get(ctx) {
    const user = ctx.state?.user;

    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const record = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { id: user.id },
        select: [
          'id',
          'documentId',
          'username',
          'email',
          'exp',
          'level',
          'profileHidden',
          'isAdmin',
          'examPassed',
          'examPassedAt',
        ],
        populate: {
          author: {
            select: ['id', 'documentId', 'name'],
            populate: {
              avatar: {
                select: ['url'],
              },
            },
          },
          // 装备的「系统自定义头像」优先于上传的 author.avatar，
          // 与帖子详情、评论、主页等其他出口的头像解析逻辑保持一致
          // （那些走 batchResolveEquippedAvatars，这里查的是当前用户单条记录）。
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

    if (!record) {
      return ctx.notFound('User not found.');
    }

    const author = record.author ?? null;
    // equippedAvatar.image 与 author.avatar 都是标准 media 对象，
    // 优先取前者；两者都缺时返回 null，前端模板会回落到默认头像。
    const equippedImage = (record).equippedAvatar?.image ?? null;
    const resolvedAvatar = equippedImage?.url ? equippedImage : (author?.avatar ?? null);

    ctx.send({
      id: record.id,
      documentId: record.documentId,
      username: record.username,
      email: record.email,
      exp: record.exp ?? 0,
      level: record.level ?? 1,
      profileHidden: !!record.profileHidden,
      isAdmin: !!record.isAdmin,
      examPassed: !!record.examPassed,
      examPassedAt: record.examPassedAt || null,
      equippedTitle: record.equippedTitle
        ? {
            documentId: record.equippedTitle.documentId,
            name: record.equippedTitle.name,
            rarity: record.equippedTitle.rarity ?? 'common',
            image: record.equippedTitle.image ?? null,
          }
        : null,
      equippedMedal: record.equippedMedal
        ? {
            documentId: record.equippedMedal.documentId,
            name: record.equippedMedal.name,
            rarity: record.equippedMedal.rarity ?? 'common',
            image: record.equippedMedal.image ?? null,
          }
        : null,
      author: author
        ? {
            documentId: author.documentId,
            name: author.name,
            avatar: withSmallWebp(resolvedAvatar),
          }
        : null,
    });
  },

  async updateVisibility(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const raw = body?.profileHidden;
    if (typeof raw !== 'boolean') {
      return ctx.badRequest('profileHidden must be a boolean');
    }
    await strapi.db.query(USER_UID).update({
      where: { id: user.id },
      data: { profileHidden: raw },
    });

    ctx.send({ success: true, profileHidden: raw });
  },

  async updateName(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const rawName = typeof body?.name === 'string' ? body.name.trim() : '';

    if (rawName.length < NAME_MIN_LENGTH || rawName.length > NAME_MAX_LENGTH) {
      return ctx.badRequest(
        `用户名长度需在 ${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH} 个字符之间`
      );
    }

    // Check username uniqueness (excluding current user)
    const conflict = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: {
          username: rawName,
          id: { $ne: user.id },
        },
        select: ['id'],
      });

    if (conflict) {
      return ctx.badRequest('该用户名已被占用');
    }

    // 先检查所有前置条件，确保扣款后不会失败
    // Find the author linked to this user
    const userRecord = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { id: user.id },
        populate: {
          author: { select: ['id', 'documentId'] },
        },
      });

    const author = userRecord?.author;
    if (!author) {
      return ctx.notFound('Author profile not found.');
    }

    // 扣除50 Denny改名费用
    const deductResult = await deductDenny(
      strapi,
      user.id,
      50,
      'spend_rename',
      `改名: ${user.username} -> ${rawName}`
    );

    if (!deductResult) {
      return ctx.internalServerError('扣除丁尼失败，请稍后重试');
    }

    if (!deductResult.success) {
      return ctx.badRequest('丁尼余额不足');
    }

    try {
      // Update both author.name and user.username
      await Promise.all([
        strapi.db.query(AUTHOR_UID).update({
          where: { id: author.id },
          data: { name: rawName },
        }),
        strapi.db.query(USER_UID).update({
          where: { id: user.id },
          data: { username: rawName },
        }),
      ]);

      ctx.send({ success: true, name: rawName });
    } catch (err) {
      // 业务操作失败，退还丁尼
      strapi.log.error('[denny] Rename failed, refunding Denny:', err);
      await addDenny(
        strapi,
        user.id,
        50,
        'refund',
        `改名失败退款: ${user.username} -> ${rawName}`
      );
      return ctx.internalServerError('改名失败，已退还丁尼');
    }
  },

  async updateBio(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const rawBio = typeof body?.bio === 'string' ? body.bio.trim() : '';

    if (rawBio.length > BIO_MAX_LENGTH) {
      return ctx.badRequest(
        `签名长度不能超过 ${BIO_MAX_LENGTH} 个字符`
      );
    }

    // Find the author linked to this user
    const userRecord = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { id: user.id },
        populate: {
          author: { select: ['id', 'documentId'] },
        },
      });

    const author = userRecord?.author;
    if (!author) {
      return ctx.notFound('Author profile not found.');
    }

    // Convert plain text to blocks format
    const bioBlocks = rawBio
      ? [
          {
            type: 'paragraph',
            children: [{ type: 'text', text: rawBio }],
          },
        ]
      : [];

    await strapi.db.query(AUTHOR_UID).update({
      where: { id: author.id },
      data: { bio: bioBlocks as any },
    });

    ctx.send({ success: true, bio: rawBio });
  },

  async getPinnedArticles(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const userRecord = await strapi.db
      .query(USER_UID)
      .findOne({
        where: { id: user.id },
        populate: {
          author: { select: ['id', 'documentId', 'profilePinnedArticles'] },
        },
      });

    const author = userRecord?.author;
    if (!author) {
      return ctx.notFound('Author profile not found.');
    }

    const limitRaw = ctx.query?.limit;
    const parsedLimit = Number.parseInt(String(limitRaw ?? ''), 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, CANDIDATE_MAX_LIMIT)
      : CANDIDATE_DEFAULT_LIMIT;

    const candidatesRaw = await strapi.documents(ARTICLE_UID).findMany({
      status: 'published',
      limit,
      sort: ['updatedAt:desc'],
      filters: {
        author: { id: author.id },
        $or: [{ isAnonymous: { $null: true } }, { isAnonymous: false }],
      },
      fields: ['documentId', 'title', 'updatedAt'],
      populate: {
        cover: { fields: ['url', 'width', 'height'] },
      },
    });

    const candidates = (candidatesRaw || []).map((item: any) => {
      const coverList = Array.isArray(item?.cover)
        ? item.cover
        : item?.cover
          ? [item.cover]
          : [];
      const cover = coverList[0] ?? null;
      return {
        documentId: item?.documentId,
        title: item?.title,
        cover: cover ? withSmallWebp(cover) : null,
        updatedAt: item?.updatedAt,
      };
    });

    const rawPinned = author.profilePinnedArticles;
    let pinned: string[] | null;
    if (rawPinned == null) {
      pinned = null;
    } else if (Array.isArray(rawPinned)) {
      const seen = new Set<string>();
      pinned = [];
      for (const item of rawPinned) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        pinned.push(trimmed);
      }
    } else {
      pinned = null;
    }

    ctx.send({
      pinned,
      candidates,
      max: PROFILE_PINNED_MAX,
    });
  },

  async updatePinnedArticles(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const normalized = normalizePinnedInput(body?.pinned);
    if (normalized === 'invalid') {
      return ctx.badRequest('pinned must be null or string[]');
    }
    if (Array.isArray(normalized) && normalized.length > PROFILE_PINNED_MAX) {
      return ctx.badRequest(`At most ${PROFILE_PINNED_MAX} articles can be pinned`);
    }

    const userRecord = await strapi.db
      .query(USER_UID)
      .findOne({
        where: { id: user.id },
        populate: {
          author: { select: ['id', 'documentId'] },
        },
      });

    const author = userRecord?.author;
    if (!author) {
      return ctx.notFound('Author profile not found.');
    }

    if (Array.isArray(normalized) && normalized.length > 0) {
      const found = await strapi.documents(ARTICLE_UID).findMany({
        status: 'published',
        limit: normalized.length,
        filters: {
          author: { id: author.id },
          documentId: { $in: normalized },
        },
        fields: ['documentId'],
      });
      const validSet = new Set<string>(
        (found || []).map((item: any) => item?.documentId).filter(Boolean),
      );
      const invalid = normalized.find((id) => !validSet.has(id));
      if (invalid) {
        return ctx.badRequest(`Invalid documentId: ${invalid}`);
      }
    }

    await strapi.documents(AUTHOR_UID).update({
      documentId: author.documentId,
      data: { profilePinnedArticles: normalized },
    });

    ctx.send({ pinned: normalized });
  },

  /** 二期个人助手占位：当前未开放 */
  async aiAssistant(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized();
    ctx.send({
      data: {
        enabled: false,
        message: '个人助手功能即将上线',
      },
    });
  },
};
