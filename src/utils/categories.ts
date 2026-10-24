import type { Core } from '@strapi/strapi';

export const CATEGORY_UID = 'api::category.category';

interface CategoryRow {
  id: number;
  documentId: string;
  slug: string | null;
  isActive: boolean | null;
  adminOnly: boolean | null;
}

const findCategoryByDocumentId = async (
  strapi: Core.Strapi,
  documentId: string,
): Promise<CategoryRow | null> =>
  strapi.db.query(CATEGORY_UID).findOne({
    where: { documentId },
    select: ['id', 'documentId', 'slug', 'isActive', 'adminOnly'],
  });

const findCategoryBySlug = async (
  strapi: Core.Strapi,
  slug: string,
): Promise<CategoryRow | null> =>
  strapi.db.query(CATEGORY_UID).findOne({
    where: { slug },
    select: ['id', 'documentId', 'slug', 'isActive', 'adminOnly'],
  });

/**
 * 从客户端传入的 category 字段提取候选标识（documentId 或 slug）。
 * 兼容多种形态：裸字符串、`{ documentId }`、`{ connect: [{ documentId }] }`、
 * `{ set: [{ documentId }] }`。
 */
const extractCategoryCandidate = (input: unknown): string | null => {
  if (input == null) return null;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed || null;
  }
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const fromArray = (arr: unknown): string | null => {
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const first = arr[0];
      if (typeof first === 'string') return first.trim() || null;
      if (first && typeof first === 'object') {
        const doc = (first as Record<string, unknown>).documentId;
        if (typeof doc === 'string' && doc.trim()) return doc.trim();
      }
      return null;
    };
    const fromConnect = fromArray(obj.connect) ?? fromArray(obj.set);
    if (fromConnect) return fromConnect;
    if (typeof obj.documentId === 'string' && obj.documentId.trim()) {
      return obj.documentId.trim();
    }
  }
  return null;
};

/**
 * 把客户端传入的 category 解析为「已上架分区」的记录（含 adminOnly 标记）。
 * 解析失败（不存在 / 已下架 / 没传）返回 null。
 */
export const resolveActiveCategory = async (
  strapi: Core.Strapi,
  input: unknown,
): Promise<CategoryRow | null> => {
  const candidate = extractCategoryCandidate(input);
  if (!candidate) return null;

  // 候选既可能是 documentId 也可能是 slug，两者都试。
  const row =
    (await findCategoryByDocumentId(strapi, candidate)) ??
    (await findCategoryBySlug(strapi, candidate));

  if (!row || row.isActive === false) return null;
  return row;
};

/**
 * 把客户端传入的 category 解析为「已上架分区」的 documentId。
 * 解析失败（不存在 / 已下架 / 没传）返回 null。
 */
export const resolveActiveCategoryDocumentId = async (
  strapi: Core.Strapi,
  input: unknown,
): Promise<string | null> => {
  const row = await resolveActiveCategory(strapi, input);
  return row?.documentId ?? null;
};

/** 把分区记录序列化为前端用的精简结构。 */
export const serializeCategory = (
  category: unknown,
): { name: string; slug: string } | null => {
  if (!category || typeof category !== 'object') return null;
  const c = category as Record<string, unknown>;
  const slug = typeof c.slug === 'string' ? c.slug : '';
  const name = typeof c.name === 'string' ? c.name : '';
  if (!slug && !name) return null;
  return {
    name,
    slug,
  };
};
