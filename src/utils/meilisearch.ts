/**
 * Meilisearch 客户端封装：供 /articles/search 与 /articles/suggest 使用。
 * 与 strapi-plugin-meilisearch 共用同一份连接配置（config/plugins.ts）。
 */
import axios from 'axios';

const ARTICLE_INDEX = 'article';

const getConfig = (strapi: any): { host: string; apiKey: string } | null => {
  const conf = strapi?.config?.get?.('plugin::meilisearch') ?? {};
  const host = typeof conf.host === 'string' ? conf.host.replace(/\/+$/, '') : '';
  if (!host) return null;
  return { host, apiKey: typeof conf.apiKey === 'string' ? conf.apiKey : '' };
};

export interface ArticleSearchHit {
  documentId: string;
  title: string;
  /** 高亮后的标题（<mark> 包裹命中片段） */
  titleHighlighted?: string;
  /** 正文命中片段（裁剪 + 高亮） */
  excerpt?: string;
  authorName?: string | null;
  categoryName?: string | null;
  categorySlug?: string | null;
  isAnonymous?: boolean;
}

export interface ArticleSearchResult {
  hits: ArticleSearchHit[];
  total: number;
}

/**
 * 全文搜索文章索引。失败时抛错，调用方应回退到 MySQL 路径。
 */
export const searchArticleIndex = async (
  strapi: any,
  q: string,
  opts: {
    start?: number;
    limit?: number;
    categorySlug?: string;
    highlight?: boolean;
  } = {},
): Promise<ArticleSearchResult> => {
  const conf = getConfig(strapi);
  if (!conf) throw new Error('Meilisearch is not configured');

  const { start = 0, limit = 20, categorySlug = '', highlight = false } = opts;

  const body: Record<string, unknown> = {
    q,
    offset: start,
    limit,
    ...(categorySlug ? { filter: [`categorySlug = ${JSON.stringify(categorySlug)}`] } : {}),
    ...(highlight
      ? {
          attributesToHighlight: ['title'],
          highlightPreTag: '<mark>',
          highlightPostTag: '</mark>',
          attributesToCrop: ['text'],
          cropLength: 24,
        }
      : {}),
  };

  const { data: res } = await axios.post(
    `${conf.host}/indexes/${ARTICLE_INDEX}/search`,
    body,
    {
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        ...(conf.apiKey ? { Authorization: `Bearer ${conf.apiKey}` } : {}),
      },
    },
  );

  const hits: ArticleSearchHit[] = (res.hits || [])
    .filter((h: any) => typeof h?.documentId === 'string' && h.documentId)
    .map((h: any) => ({
      documentId: h.documentId,
      title: typeof h.title === 'string' ? h.title : '',
      titleHighlighted: h._formatted?.title,
      excerpt: h._formatted?.text,
      authorName: h.authorName ?? null,
      categoryName: h.categoryName ?? null,
      categorySlug: h.categorySlug ?? null,
      isAnonymous: h.isAnonymous === true,
    }));

  const total =
    typeof res.estimatedTotalHits === 'number'
      ? res.estimatedTotalHits
      : typeof res.totalHits === 'number'
        ? res.totalHits
        : hits.length;

  return { hits, total };
};
