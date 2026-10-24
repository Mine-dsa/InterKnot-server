import type { Context } from 'koa';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { getClientIp } from '../../../utils/common';

const USER_UID = 'plugin::users-permissions.user';
const ARTICLE_UID = 'api::article.article';
const COMMENT_UID = 'api::comment.comment';
const REPORT_UID = 'api::report.report';
const AUTHOR_UID = 'api::author.author';

const MEDIA_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_ARTICLE_COVERS = 9;

/** 取 multipart 单文件（formidable 结果可能是数组） */
function pickUploadFile(ctx: Context): any {
  let file: any = (ctx.request as any).files?.files;
  if (Array.isArray(file)) file = file[0];
  return file;
}

/** 校验并上传单张图片，返回 upload.file 记录 */
async function uploadImageFile(ctx: Context, file: any, name: string): Promise<any | null> {
  if (!file?.filepath || !file?.size) {
    ctx.badRequest('缺少图片文件（files 字段）');
    return null;
  }
  const mime = String(file.mimetype || '').toLowerCase();
  if (!MEDIA_MIMES.has(mime)) {
    ctx.badRequest(`不支持的图片格式: ${mime || '未知'}`);
    return null;
  }
  const uploaded = await strapi.plugin('upload').service('upload').upload({
    data: { fileInfo: { name: name || file.originalFilename || 'image', alternativeText: null, caption: null } },
    files: [
      {
        filepath: file.filepath,
        originalFilename: file.originalFilename || `image.${mime.split('/')[1] || 'png'}`,
        mimetype: mime,
        size: file.size,
      },
    ],
  });
  return uploaded?.[0] ?? null;
}

/**
 * 生成 -small.webp 缩略图（项目展示约定：头像/封面等出口会把 url 加该后缀取小图）。
 * 与 direct-upload 保持一致：128x128 居中裁剪。
 */
async function generateSmallWebp(url: unknown, size = 128) {
  try {
    const u = typeof url === 'string' ? url : '';
    if (!u.startsWith('/uploads/')) return;
    const srcPath = path.join(process.cwd(), 'public', u);
    const smallPath = srcPath + '-small.webp';
    if (fs.existsSync(srcPath) && !fs.existsSync(smallPath)) {
      await sharp(srcPath).resize(size, size, { fit: 'cover' }).webp({ quality: 80 }).toFile(smallPath);
    }
  } catch (err) {
    strapi.log.warn(`[admin] small webp generation failed for ${url}: ${err}`);
  }
}

/** 该 documentId 对应的所有文章行（草稿 + 已发布） */
async function findArticleRows(documentId: string) {
  return strapi.db.query(ARTICLE_UID).findMany({
    where: { documentId },
    select: ['id', 'documentId', 'publishedAt'],
    orderBy: { id: 'asc' },
  });
}

function pickPublishedRow(rows: any[]): any {
  return rows.find((r) => r?.publishedAt) || rows[0];
}

function serializeMedia(m: any) {
  if (!m) return null;
  return {
    id: m.id ?? null,
    documentId: m.documentId ?? null,
    url: m.url ?? null,
    width: m.width ?? null,
    height: m.height ?? null,
    name: m.name ?? null,
  };
}

async function getArticleCoverIds(rowId: number): Promise<number[]> {
  const full = await strapi.db.query(ARTICLE_UID).findOne({
    where: { id: rowId },
    select: ['id'],
    populate: { cover: { select: ['id'] } },
  });
  const list = Array.isArray(full?.cover) ? full.cover : full?.cover ? [full.cover] : [];
  return list.map((c: any) => Number(c.id)).filter((n: number) => Number.isInteger(n) && n > 0);
}

/** 同步写入草稿 + 已发布两行的封面关系，避免两版本不一致 */
async function setArticleCovers(rows: any[], fileIds: number[]) {
  for (const row of rows) {
    await strapi.db.query(ARTICLE_UID).update({
      where: { id: row.id },
      data: { cover: fileIds },
    });
  }
}

const MD_IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMG_RE = /<img\b[^>]*>/gi;
const HTML_SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;

function extractImageUrls(text: unknown): string[] {
  const s = typeof text === 'string' ? text : '';
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  let m: RegExpExecArray | null;
  MD_IMG_RE.lastIndex = 0;
  while ((m = MD_IMG_RE.exec(s))) push(m[1]);
  HTML_IMG_RE.lastIndex = 0;
  while ((m = HTML_IMG_RE.exec(s))) {
    const src = (m[0].match(HTML_SRC_RE) || [])[1];
    if (src) push(src);
  }
  return out;
}

function removeImageToken(text: string, url: string): string {
  let out = text.replace(MD_IMG_RE, (whole: string, u: string) => (u === url ? '' : whole));
  out = out.replace(HTML_IMG_RE, (whole: string) => {
    const src = (whole.match(HTML_SRC_RE) || [])[1];
    return src === url ? '' : whole;
  });
  return out;
}

function replaceImageUrl(text: string, oldUrl: string, newUrl: string): string {
  let out = text.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?\s*)\)/g,
    (whole: string, alt: string, u: string, tail: string) =>
      u === oldUrl ? `![${alt}](${newUrl}${tail})` : whole,
  );
  out = out.replace(HTML_IMG_RE, (whole: string) =>
    whole.replace(/\bsrc\s*=\s*(["'])([^"']+)\1/i, (mm: string, q: string, u: string) =>
      u === oldUrl ? `src=${q}${newUrl}${q}` : mm,
    ),
  );
  return out;
}

async function setArticleText(documentId: string, text: string) {
  await strapi.db.query(ARTICLE_UID).updateMany({
    where: { documentId },
    data: { text },
  });
}


/** 公告默认日期：用于把公告置顶到文章流最前（feed 按 bumpedAt desc 排序） */
const DEFAULT_ANNOUNCEMENT_DATE = '9999-12-31T00:00:00.000Z';

/**
 * 首个管理员自提的客户端 IP 是否为本机（未配置 SETUP_ADMIN_KEY 时的兜底门禁：
 * key 缺失时仅允许 loopback 客户端自提，阻止局域网/公网任意注册用户抢注管理员）。
 */
const isLoopbackIp = (ip: string): boolean =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export default {
  async listUsers(ctx: Context) {
    const { search, blocked, page = '1', pageSize = '20' } = ctx.query as Record<string, string>;
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * (parseInt(pageSize, 10) || 20);
    const limit = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const where: any = {};

    if (blocked === 'true') where.blocked = true;
    else if (blocked === 'false') where.blocked = false;

    if (search) {
      const q = `%${search}%`;
      where.$or = [
        { username: { $containsi: search } },
        { email: { $containsi: search } },
      ];
    }

    const [users, total] = await Promise.all([
      strapi.db.query(USER_UID).findMany({
        where,
        select: ['id', 'username', 'email', 'blocked', 'confirmed', 'isAdmin', 'examPassed', 'level', 'exp', 'denny', 'createdAt', 'updatedAt'],
        populate: { author: { populate: { avatar: { select: ['url', 'width', 'height'] } } } },
        orderBy: { createdAt: 'desc' },
        offset,
        limit,
      }),
      strapi.db.query(USER_UID).count({ where }),
    ]);

    ctx.body = { data: users, meta: { total, page: parseInt(page, 10) || 1, pageSize: limit } };
  },

  async getUser(ctx: Context) {
    const { id } = ctx.params;
    const user = await strapi.db.query(USER_UID).findOne({
      where: { id },
      select: ['id', 'username', 'email', 'blocked', 'confirmed', 'isAdmin', 'examPassed', 'level', 'exp', 'denny', 'createdAt', 'updatedAt'],
    });

    if (!user) return ctx.notFound('用户不存在');
    ctx.body = { data: user };
  },

  async updateUser(ctx: Context) {
    const { id } = ctx.params;
    const body = ctx.request.body as any;

    const user = await strapi.db.query(USER_UID).findOne({
      where: { id },
      select: ['id'],
    });
    if (!user) return ctx.notFound('用户不存在');

    const updateData: any = {};

    if (body.username !== undefined) {
      if (typeof body.username !== 'string' || body.username.trim().length < 2) {
        return ctx.badRequest('用户名至少需要 2 个字符');
      }
      const existing = await strapi.db.query(USER_UID).findOne({
        where: { username: body.username.trim(), id: { $ne: id } },
        select: ['id'],
      });
      if (existing) return ctx.badRequest('该用户名已被使用');
      updateData.username = body.username.trim();
    }

    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 6) {
        return ctx.badRequest('密码长度不能少于 6 位');
      }
      updateData.password = body.password;
    }

    if (body.examPassed !== undefined) updateData.examPassed = !!body.examPassed;
    if (body.blocked !== undefined) updateData.blocked = !!body.blocked;
    if (body.isAdmin !== undefined) updateData.isAdmin = !!body.isAdmin;
    if (body.email !== undefined && typeof body.email === 'string') {
      updateData.email = body.email.trim().toLowerCase();
    }
    if (body.level !== undefined) updateData.level = parseInt(body.level, 10) || 0;
    if (body.exp !== undefined) updateData.exp = parseInt(body.exp, 10) || 0;
    if (body.denny !== undefined) updateData.denny = Math.min(9999, Math.max(0, parseInt(body.denny, 10) || 0));

    if (Object.keys(updateData).length === 0) {
      return ctx.badRequest('没有需要更新的字段');
    }

    const updatedUser = await strapi.plugin('users-permissions').service('user').edit(id, updateData);

    if (updateData.username) {
      try {
        const author = await strapi.db.query('api::author.author').findOne({
          where: { user: id },
          select: ['id', 'name'],
        });
        if (author) {
          await strapi.db.query('api::author.author').update({
            where: { id: author.id },
            data: { name: updateData.username },
          });
        }
      } catch { /* non-critical */ }
    }

    const sanitized = await strapi
      .contentAPI.sanitize.output(updatedUser, strapi.getModel(USER_UID), { auth: ctx.state?.auth || {} });

    ctx.body = { data: sanitized };
  },

  async deleteUser(ctx: Context) {
    const { id } = ctx.params;
    const user = await strapi.db.query(USER_UID).findOne({ where: { id }, select: ['id'] });
    if (!user) return ctx.notFound('用户不存在');

    await strapi.db.query(USER_UID).delete({ where: { id } });
    ctx.body = { success: true };
  },

  async listArticles(ctx: Context) {
    const { search, page = '1', pageSize = '20', kind } = ctx.query as Record<string, string>;
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * (parseInt(pageSize, 10) || 20);
    const limit = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const where: any = {
      publishedAt: { $notNull: true },
    };

    // 公告/文章分离：kind=announcement 只公告，kind=article 只普通文章，缺省为全部
    if (kind === 'announcement') {
      where.isAnnouncement = true;
    } else if (kind === 'article') {
      where.isAnnouncement = { $ne: true };
    }

    if (search) {
      where.$or = [
        { title: { $containsi: search } },
        { text: { $containsi: search } },
      ];
    }

    const articles = await strapi.db.query(ARTICLE_UID).findMany({
      where,
      select: [
        'id',
        'documentId',
        'title',
        'text',
        'publishedAt',
        'bumpedAt',
        'isAnnouncement',
        'views',
        'likescount',
        'commentscount',
        'createdAt',
      ],
      populate: {
        author: { select: ['id', 'name'] },
      },
      orderBy: { createdAt: 'desc' },
      offset,
      limit,
    });

    const total = await strapi.db.query(ARTICLE_UID).count({ where });

    ctx.body = { data: articles, meta: { total, page: parseInt(page, 10) || 1, pageSize: limit } };
  },

  async deleteArticle(ctx: Context) {
    const { id } = ctx.params;
    const article = await strapi.db.query(ARTICLE_UID).findOne({ where: { documentId: id }, select: ['id'] });
    if (!article) return ctx.notFound('帖子不存在');

    await strapi.db.query(ARTICLE_UID).delete({ where: { id: article.id } });
    ctx.body = { success: true };
  },

  async listComments(ctx: Context) {
    const { search, page = '1', pageSize = '20' } = ctx.query as Record<string, string>;
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * (parseInt(pageSize, 10) || 20);
    const limit = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const where: any = {};

    if (search) {
      where.content = { $containsi: search };
    }

    const comments = await strapi.db.query(COMMENT_UID).findMany({
      where,
      select: ['id', 'documentId', 'content', 'createdAt'],
      populate: {
        author: { select: ['id', 'name'] },
        article: { select: ['id', 'documentId', 'title'] },
      },
      orderBy: { createdAt: 'desc' },
      offset,
      limit,
    });

    const total = await strapi.db.query(COMMENT_UID).count({ where });

    ctx.body = { data: comments, meta: { total, page: parseInt(page, 10) || 1, pageSize: limit } };
  },

  async deleteComment(ctx: Context) {
    const { id } = ctx.params;
    const comment = await strapi.db.query(COMMENT_UID).findOne({ where: { documentId: id }, select: ['id'] });
    if (!comment) return ctx.notFound('评论不存在');

    await strapi.db.query(COMMENT_UID).delete({ where: { id: comment.id } });
    ctx.body = { success: true };
  },

  /**
   * 发布公告（本质是标记 isAnnouncement 的文章）。
   * body: { title, text, date? } —— date 用于置顶（feed 按 bumpedAt desc 排序），
   * 未传时默认 9999-12-31，使公告稳定排在最前。
   */
  async createAnnouncement(ctx: Context) {
    const { title, text, date } = ctx.request.body as any;
    if (!title || !text) return ctx.badRequest('标题和内容不能为空');

    const rawDate = typeof date === 'string' && date.trim() ? date.trim() : DEFAULT_ANNOUNCEMENT_DATE;
    const dateObj = new Date(rawDate);
    if (Number.isNaN(dateObj.getTime())) return ctx.badRequest('日期格式不正确');
    const iso = dateObj.toISOString();

    try {
      const article = await strapi.documents(ARTICLE_UID).create({
        data: {
          title,
          text,
          isAnonymous: false,
          isAnnouncement: true,
          publishedAt: dateObj,
          bumpedAt: dateObj,
        },
        status: 'published',
      });

      // publish/生命周期可能覆写时间戳：直接落库确保置顶日期生效。
      // 只更新已发布行（published_at 非空）：draftAndPublish 会同时存在草稿行，
      // 若把草稿行的 published_at 也写上，列表按 publishedAt 过滤时会重复出现该公告。
      await strapi.db
        .connection('articles')
        .where({ document_id: article.documentId })
        .whereNotNull('published_at')
        .update({ published_at: iso, bumped_at: iso });

      ctx.status = 201;
      ctx.body = { data: article };
    } catch (err: any) {
      return ctx.badRequest(err.message || '创建公告失败');
    }
  },

  /**
   * 管理员编辑任意文章（含公告）：标题 / 正文 / 发布时间 / 置顶排序时间。
   * 直接落库（同时覆盖 draft/published 两行），绕过作者策略与考试门槛——管理员特权。
   */
  async updateArticle(ctx: Context) {
    const { id } = ctx.params;
    const body = (ctx.request.body || {}) as any;

    const article = await strapi.db.query(ARTICLE_UID).findOne({
      where: { documentId: id },
      select: ['id', 'documentId'],
    });
    if (!article) return ctx.notFound('帖子不存在');

    const data: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 50) return ctx.badRequest('标题必填且不超过 50 字符');
      data.title = title;
    }
    if (body.text !== undefined) {
      const text = typeof body.text === 'string' ? body.text : '';
      if (!text) return ctx.badRequest('正文不能为空');
      if (text.length > 10240) return ctx.badRequest('正文不能超过 10240 字符');
      data.text = text;
    }
    let publishedIso: string | null = null;
    if (body.publishedAt !== undefined && body.publishedAt !== null && body.publishedAt !== '') {
      const d = new Date(String(body.publishedAt));
      if (Number.isNaN(d.getTime())) return ctx.badRequest('发布时间格式不正确');
      publishedIso = d.toISOString();
    }
    let bumpedIso: string | null = null;
    if (body.bumpedAt !== undefined && body.bumpedAt !== null && body.bumpedAt !== '') {
      const d = new Date(String(body.bumpedAt));
      if (Number.isNaN(d.getTime())) return ctx.badRequest('置顶排序时间格式不正确');
      bumpedIso = d.toISOString();
    }

    try {
      if (Object.keys(data).length > 0) {
        await strapi.db.query(ARTICLE_UID).updateMany({
          where: { documentId: article.documentId },
          data,
        });
      }
      const timePatch: Record<string, unknown> = {};
      if (publishedIso) timePatch.published_at = publishedIso;
      if (bumpedIso) timePatch.bumped_at = bumpedIso;
      if (Object.keys(timePatch).length > 0) {
        // 同 createAnnouncement：只改已发布行，避免草稿行被写入 published_at 后重复出现
        await strapi.db
          .connection('articles')
          .where({ document_id: article.documentId })
          .whereNotNull('published_at')
          .update(timePatch);
      }

      const fresh = await strapi.db.query(ARTICLE_UID).findOne({
        where: { documentId: article.documentId },
        select: ['documentId', 'title', 'text', 'publishedAt', 'bumpedAt', 'isAnnouncement'],
      });
      ctx.body = { success: true, data: fresh };
    } catch (err: any) {
      return ctx.badRequest(err.message || '保存失败');
    }
  },

  /**
   * 管理员上传图片（用于文章正文内嵌图片等）。
   * multipart：files 字段；返回首张图片的 url 与 fileId。
   */
  async uploadMedia(ctx: Context) {
    let file: any = (ctx.request as any).files?.files;
    if (Array.isArray(file)) file = file[0];
    if (!file?.filepath || !file?.size) return ctx.badRequest('缺少图片文件（files 字段）');

    const mime = String(file.mimetype || '').toLowerCase();
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
    if (!allowed.has(mime)) return ctx.badRequest(`不支持的图片格式: ${mime || '未知'}`);

    try {
      const uploaded = await strapi.plugin('upload').service('upload').upload({
        data: { fileInfo: { name: file.originalFilename || 'image', alternativeText: null, caption: null } },
        files: [
          {
            filepath: file.filepath,
            originalFilename: file.originalFilename || `image.${mime.split('/')[1] || 'png'}`,
            mimetype: mime,
            size: file.size,
          },
        ],
      });
      const f = uploaded?.[0];
      if (!f?.id) return ctx.internalServerError('图片保存失败');
      ctx.send({ success: true, fileId: f.id, url: f.url });
    } catch (err: any) {
      return ctx.badRequest(err.message || '图片上传失败');
    }
  },

  /**
   * 管理员修改指定用户头像（multipart：files，前端已按 1:1 裁剪）。
   * 直接写入 author.avatar（用户头像的真实存储位），并清空系统头像装备，
   * 上传即顶掉旧头像，无需用户侧消耗丁尼。
   */
  async setUserAvatar(ctx: Context) {
    const { id } = ctx.params;
    const user = await strapi.db.query(USER_UID).findOne({ where: { id }, select: ['id'] });
    if (!user) return ctx.notFound('用户不存在');

    const author = await strapi.db.query(AUTHOR_UID).findOne({
      where: { user: id },
      select: ['id'],
    });
    if (!author) return ctx.badRequest('该用户没有作者资料');

    const file = pickUploadFile(ctx);
    const uploaded = await uploadImageFile(ctx, file, file?.originalFilename || 'avatar');
    if (!uploaded?.id) return; // uploadImageFile 已写入 4xx 响应
    await generateSmallWebp(uploaded.url, 128);

    await strapi.db.query(AUTHOR_UID).update({
      where: { id: author.id },
      data: { avatar: uploaded.id },
    });
    await strapi.db.query(USER_UID).update({
      where: { id },
      data: { equippedAvatar: null },
    });

    strapi.log.info(`[admin] 管理员 ${ctx.state?.user?.id} 修改用户 #${id} 头像`);
    ctx.send({
      success: true,
      avatar: { url: uploaded.url ?? null, width: uploaded.width ?? null, height: uploaded.height ?? null },
    });
  },

  /**
   * 单篇文章图片总览：封面（cover 关系，按顺序）+ 正文内嵌图片（从 text 解析）。
   */
  async listArticleImages(ctx: Context) {
    const { id } = ctx.params;
    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');
    const pub = pickPublishedRow(rows);
    const full = await strapi.db.query(ARTICLE_UID).findOne({
      where: { id: pub.id },
      select: ['id', 'documentId', 'text'],
      populate: { cover: { select: ['id', 'documentId', 'url', 'width', 'height', 'name'] } },
    });
    const coverList = Array.isArray(full?.cover) ? full.cover : full?.cover ? [full.cover] : [];
    ctx.send({
      data: {
        documentId: id,
        text: typeof full?.text === 'string' ? full.text : '',
        covers: coverList.map(serializeMedia),
        inline: extractImageUrls(full?.text),
      },
    });
  },

  /** 添加封面：上传后追加到 cover 关系末尾 */
  async addArticleCover(ctx: Context) {
    const { id } = ctx.params;
    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');

    const file = pickUploadFile(ctx);
    const uploaded = await uploadImageFile(ctx, file, file?.originalFilename || 'cover');
    if (!uploaded?.id) return;
    await generateSmallWebp(uploaded.url, 128);

    const pub = pickPublishedRow(rows);
    const current = await getArticleCoverIds(pub.id);
    if (current.length >= MAX_ARTICLE_COVERS) {
      return ctx.badRequest(`封面最多 ${MAX_ARTICLE_COVERS} 张`);
    }
    await setArticleCovers(rows, [...current, uploaded.id]);
    ctx.send({ success: true, cover: serializeMedia(uploaded) });
  },

  /** 替换封面：同位置替换为上传的新图（旧图仅解除关联，不删除文件） */
  async replaceArticleCover(ctx: Context) {
    const { id, fileId } = ctx.params;
    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');

    const pub = pickPublishedRow(rows);
    const current = await getArticleCoverIds(pub.id);
    const idx = current.indexOf(Number(fileId));
    if (idx < 0) return ctx.notFound('封面不存在');

    const file = pickUploadFile(ctx);
    const uploaded = await uploadImageFile(ctx, file, file?.originalFilename || 'cover');
    if (!uploaded?.id) return;
    await generateSmallWebp(uploaded.url, 128);

    const next = [...current];
    next[idx] = uploaded.id;
    await setArticleCovers(rows, next);
    ctx.send({ success: true, cover: serializeMedia(uploaded) });
  },

  /** 删除封面：从 cover 关系移除（不删除上传文件，避免误伤其他引用） */
  async deleteArticleCover(ctx: Context) {
    const { id, fileId } = ctx.params;
    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');

    const pub = pickPublishedRow(rows);
    const current = await getArticleCoverIds(pub.id);
    const next = current.filter((n) => n !== Number(fileId));
    if (next.length === current.length) return ctx.notFound('封面不存在');

    await setArticleCovers(rows, next);
    ctx.send({ success: true, covers: next });
  },

  /** 调整封面顺序（order 为 fileId 数组，需与现有集合一致） */
  async reorderArticleCovers(ctx: Context) {
    const { id } = ctx.params;
    const body = (ctx.request.body || {}) as any;
    const order: unknown = body.order;
    if (!Array.isArray(order) || !order.every((n) => Number.isInteger(Number(n)))) {
      return ctx.badRequest('order 必须是 fileId 数组');
    }
    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');

    const pub = pickPublishedRow(rows);
    const current = await getArticleCoverIds(pub.id);
    const next = order.map((n) => Number(n));
    const sameSet =
      next.length === current.length &&
      [...next].sort((a, b) => a - b).join(',') === [...current].sort((a, b) => a - b).join(',');
    if (!sameSet) return ctx.badRequest('order 与现有封面集合不一致');

    await setArticleCovers(rows, next);
    ctx.send({ success: true, covers: next });
  },

  /** 删除正文内嵌图片：从 text 中移除该图对应的 Markdown/HTML 片段 */
  async removeInlineImage(ctx: Context) {
    const { id } = ctx.params;
    const body = (ctx.request.body || {}) as any;
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) return ctx.badRequest('url 不能为空');

    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');
    const pub = pickPublishedRow(rows);
    const full = await strapi.db.query(ARTICLE_UID).findOne({
      where: { id: pub.id },
      select: ['text'],
    });
    const text = typeof full?.text === 'string' ? full.text : '';
    const next = removeImageToken(text, url);
    if (next === text) return ctx.notFound('正文中未找到该图片');
    await setArticleText(id, next);
    ctx.send({ success: true, text: next });
  },

  /** 替换正文内嵌图片：上传新图并把 text 中旧图 URL 换成新图 URL */
  async replaceInlineImage(ctx: Context) {
    const { id } = ctx.params;
    const body = (ctx.request.body || {}) as any;
    const oldUrl = typeof body.oldUrl === 'string' ? body.oldUrl.trim() : '';
    if (!oldUrl) return ctx.badRequest('oldUrl 不能为空');

    const rows = await findArticleRows(id);
    if (!rows.length) return ctx.notFound('帖子不存在');

    const file = pickUploadFile(ctx);
    const uploaded = await uploadImageFile(ctx, file, file?.originalFilename || 'inline');
    if (!uploaded?.id) return;

    const pub = pickPublishedRow(rows);
    const full = await strapi.db.query(ARTICLE_UID).findOne({
      where: { id: pub.id },
      select: ['text'],
    });
    const text = typeof full?.text === 'string' ? full.text : '';
    const next = replaceImageUrl(text, oldUrl, uploaded.url);
    if (next === text) return ctx.notFound('正文中未找到该图片');
    await setArticleText(id, next);
    ctx.send({ success: true, url: uploaded.url, text: next });
  },

  /**
   * 举报记录列表（含举报者/被举报者/文章/评论信息）。
   * 支持 kind 过滤（article/comment/user）与分页。
   */
  async listReports(ctx: Context) {
    const { page = '1', pageSize = '20', kind } = ctx.query as Record<string, string>;
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * (parseInt(pageSize, 10) || 20);
    const limit = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));

    const where: any = {};
    if (kind === 'article' || kind === 'comment' || kind === 'user') {
      where.targetType = kind;
    }

    const rows = await strapi.db.query(REPORT_UID).findMany({
      where,
      orderBy: { createdAt: 'desc' },
      offset,
      limit,
      populate: {
        reporter: {
          select: ['id', 'username'],
          populate: { author: { select: ['documentId', 'name'] } },
        },
        targetUser: {
          select: ['id', 'username'],
          populate: { author: { select: ['documentId', 'name'] } },
        },
        article: {
          select: ['id', 'documentId', 'title'],
          populate: { author: { select: ['documentId', 'name'] } },
        },
        comment: {
          select: ['id', 'documentId', 'content'],
          populate: {
            article: { select: ['documentId', 'title'] },
            author: { select: ['documentId', 'name'] },
          },
        },
      },
    });

    const total = await strapi.db.query(REPORT_UID).count({ where });

    const data = (rows || []).map((r: any) => ({
      documentId: r.documentId,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      detail: r.detail ?? null,
      createdAt: r.createdAt,
      reporter: r.reporter
        ? {
            id: r.reporter.id,
            username: r.reporter.username,
            authorDocumentId: r.reporter.author?.documentId ?? null,
          }
        : null,
      targetUser: r.targetUser
        ? {
            id: r.targetUser.id,
            username: r.targetUser.username,
            authorDocumentId: r.targetUser.author?.documentId ?? null,
          }
        : null,
      article: r.article
        ? {
            documentId: r.article.documentId,
            title: r.article.title,
            author: r.article.author
              ? { documentId: r.article.author.documentId, name: r.article.author.name }
              : null,
          }
        : r.comment?.article
          ? {
              documentId: r.comment.article.documentId,
              title: r.comment.article.title,
              author: r.comment.author
                ? { documentId: r.comment.author.documentId, name: r.comment.author.name }
                : null,
            }
          : null,
      comment: r.comment
        ? {
            documentId: r.comment.documentId,
            content: r.comment.content,
            author: r.comment.author
              ? { documentId: r.comment.author.documentId, name: r.comment.author.name }
              : null,
          }
        : null,
    }));

    ctx.body = { data, meta: { total, page: parseInt(page, 10) || 1, pageSize: limit } };
  },

  /** 删除举报记录 */
  async deleteReport(ctx: Context) {
    const { id } = ctx.params;
    const report = await strapi.db.query(REPORT_UID).findOne({
      where: { documentId: id },
      select: ['id'],
    });
    if (!report) return ctx.notFound('举报记录不存在');

    await strapi.db.query(REPORT_UID).delete({ where: { id: report.id } });
    ctx.body = { success: true };
  },

  /**
   * 首个管理员自提端点。
   *
   * 门禁（满足其一才能自提）：
   *  1. 请求携带正确的 SETUP_ADMIN_KEY（由启动器生成，见 data/secrets.env）；
   *  2. 未配置 SETUP_ADMIN_KEY 的部署：仅允许本机（loopback）客户端。
   *
   * 叠加「全库无管理员」前置检查 + 初始化锁复核，关闭原 count→edit 的 TOCTOU 窗口
   * （任意远程注册用户抢注管理员）。已存在管理员时端点一律 403。
   */
  async setupFirstAdmin(ctx: Context) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('需要登录');

    const setupKey = process.env.SETUP_ADMIN_KEY?.trim() || '';
    const clientIp = getClientIp(ctx);
    const viaKey = setupKey !== '' && ctx.request?.body?.setupKey === setupKey;
    const viaLoopback = setupKey === '' && isLoopbackIp(clientIp);
    if (!viaKey && !viaLoopback) {
      return ctx.forbidden('需要 SETUP_ADMIN_KEY 或从服务器本机访问才能设置首个管理员');
    }

    // 初始化锁：core store 单例标记。已初始化过的实例永久关闭此端点。
    const store = strapi.store({ type: 'plugin', name: 'admin' });
    const claimed: unknown = await store.get({ key: 'setup_admin_claimed' });
    if (claimed === true) {
      return ctx.forbidden('首个管理员已设置，请由现有管理员进行授权');
    }

    const adminCount = await strapi.db.query(USER_UID).count({
      where: { isAdmin: true },
    });
    if (adminCount > 0) {
      // 老实例升级路径：库里已有管理员但锁未写入——补锁后拒绝
      await store.set({ key: 'setup_admin_claimed', value: true });
      return ctx.forbidden('已存在管理员，请由现有管理员进行授权');
    }

    await strapi.plugin('users-permissions').service('user').edit(user.id, { isAdmin: true });

    // 复核：确认自提后全库确实存在管理员（并发下仅一方成功；后到者在此被锁）
    const adminAfter = await strapi.db.query(USER_UID).count({
      where: { isAdmin: true },
    });
    if (adminAfter < 1) {
      return ctx.internalServerError('设置失败，请稍后重试');
    }
    await store.set({ key: 'setup_admin_claimed', value: true });

    strapi.log.warn(`[setup-admin] 首个管理员已由用户 #${user.id} (${clientIp}) 通过 ${viaKey ? 'SETUP_ADMIN_KEY' : '本机访问'} 设置`);

    ctx.body = { success: true, message: '已设置为管理员' };
  },
};
