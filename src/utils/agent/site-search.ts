import type { Core } from '@strapi/strapi';
import { stripMentionsToPlain } from '../../api/comment/utils/mention';

/**
 * 绳网站内搜帖（供 AI 私信推荐真实帖子用）。
 * 复用 article searchLite 的策略：优先 MySQL 全文 MATCH，回退 $contains。
 */

export interface AgentSearchHit {
  documentId: string;
  title: string;
  snippet: string;
}

/** 用户表达「找帖/推荐」意图的触发词 */
const SEARCH_INTENT =
  /(帖子|帖文|帖|推荐|搜索|搜一下|搜|查找|查一下|有没有|有无|找一下|找找|找|看看有|post|article|链接)/i;

/** 提取关键词时剔除的常见停用词 */
const STOPWORDS =
  /(请帮我|帮我|我想|想要|一下|有没有|有无|关于|可以|帮忙|推荐|搜索|搜|查找|查|帖子|帖文|帖|看看|find|me|some|about|the|posts?|articles?)/gi;

/**
 * 从用户最新消息判断是否存在「找帖」意图并提取检索关键词。
 * 无意图时返回 null（调用方据此跳过搜索，保持普通对话）。
 */
export function extractSiteSearchQuery(message: string): string | null {
  const text = stripMentionsToPlain(message || '').trim();
  if (!text || !SEARCH_INTENT.test(text)) return null;

  const cleaned = text
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(STOPWORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const q = cleaned || text;
  return q.length >= 2 ? q.slice(0, 60) : null;
}

/** 执行搜索，返回 top-N 已发布、非匿名帖子。 */
export async function searchArticlesForAgent(
  strapi: Core.Strapi,
  query: string,
  limit = 5,
): Promise<AgentSearchHit[]> {
  const q = (query || '').trim();
  if (q.length < 2) return [];

  const knex = strapi.db.connection;
  let matchedIds: number[] = [];
  try {
    const rows = await knex('articles')
      .select('id')
      .whereNotNull('published_at')
      .whereRaw('MATCH(title, text) AGAINST(? IN BOOLEAN MODE)', [q])
      .limit(limit * 3);
    matchedIds = rows.map((r: { id: number }) => r.id);
  } catch {
    matchedIds = [];
  }

  const where: Record<string, unknown> =
    matchedIds.length > 0
      ? { id: { $in: matchedIds } }
      : { $or: [{ title: { $contains: q } }, { text: { $contains: q } }] };

  const rows = await strapi.db.query('api::article.article').findMany({
    where: { ...where, isAnonymous: { $ne: true }, publishedAt: { $notNull: true } },
    orderBy: [{ bumpedAt: 'desc' }, { id: 'desc' }],
    limit,
    select: ['documentId', 'title', 'text'],
  });

  return (rows || []).map((r: { documentId: string; title?: string; text?: string }) => ({
    documentId: r.documentId,
    title: r.title || '（无标题）',
    snippet: String(r.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 120),
  }));
}

/** 将搜索结果格式化为 markdown 链接，AI 回复时保留即可让前端渲染为可点击链接。 */
export function formatSearchResults(hits: AgentSearchHit[]): string {
  if (!hits.length) return '（未找到匹配帖子）';
  return hits
    .map((h, i) => `${i + 1}. [${h.title}](/post/${h.documentId})\n   ${h.snippet}`)
    .join('\n');
}
