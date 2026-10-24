import type { Context } from 'koa';
const FILE_UID = 'plugin::upload.file';

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

const parsePositiveInt = (value: unknown, fallback: number, max?: number) => {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }

  const rounded = Math.floor(raw);
  return typeof max === 'number' ? Math.min(rounded, max) : rounded;
};

// 用户图库：仅返回当前登录用户曾上传/复用过的文件，按时间倒序。
// 字段经过白名单挑选，不会泄露 uploaders 关系本身（保持匿名安全）。
export default {
  async list(ctx: Context) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    const query = ctx.query ?? {};
    const page = parsePositiveInt(query.page, 1);
    const pageSize = parsePositiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const where = { uploaders: { id: user.id } };

    const [items, total] = await Promise.all([
      strapi.db.query(FILE_UID).findMany({
        where,
        orderBy: { createdAt: 'desc' },
        offset: (page - 1) * pageSize,
        limit: pageSize,
        select: [
          'id',
          'documentId',
          'name',
          'url',
          'mime',
          'size',
          'width',
          'height',
          'createdAt',
        ],
      }),
      strapi.db.query(FILE_UID).count({ where }),
    ]);

    ctx.send({
      data: items,
      meta: {
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    });
  },
};
