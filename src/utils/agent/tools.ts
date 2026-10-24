import type { Core } from '@strapi/strapi';
import { searchArticlesForAgent, formatSearchResults } from './site-search';
import { stripMentionsToPlain } from '../../api/comment/utils/mention';
import { buildAnonymousName } from '../anonymous';

/**
 * 角色 Tool Use（3.3.3）后端执行层。
 * worker 把 LLM 返回的 tool_calls 转发到 /agent/internal/tool 由此执行，
 * 返回纯文本结果再喂回 LLM。所有工具均只读、面向公开内容，无副作用。
 */

const ALLOWED_TOOLS = new Set([
  'search_posts',
  'get_hot_posts',
  'get_user_info',
  'get_post_content',
  'get_post_comments',
]);

export function isAllowedTool(name: string): boolean {
  return ALLOWED_TOOLS.has(name);
}

async function toolSearchPosts(strapi: Core.Strapi, args: any): Promise<string> {
  const query = String(args?.query || '').trim();
  if (query.length < 2) return '（未提供有效检索词）';
  const hits = await searchArticlesForAgent(strapi, query, 5);
  if (!hits.length) return `没有找到与「${query}」相关的帖子。`;
  return formatSearchResults(hits);
}

async function toolGetHotPosts(strapi: Core.Strapi, args: any): Promise<string> {
  const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 10);
  const rows: any[] = await strapi.db.query('api::article.article').findMany({
    where: { publishedAt: { $notNull: true }, isAnonymous: { $ne: true } },
    select: ['documentId', 'title', 'commentscount', 'likescount', 'views', 'bumpedAt'],
    orderBy: [{ bumpedAt: 'desc' }],
    limit,
  });
  if (!rows.length) return '当前没有可推荐的热帖。';
  return rows
    .map((r, i) => {
      const stats = `赞${r.likescount ?? 0}·评${r.commentscount ?? 0}·阅${r.views ?? 0}`;
      return `${i + 1}. [${r.title || '(无标题)'}](/post/${r.documentId})（${stats}）`;
    })
    .join('\n');
}

async function toolGetUserInfo(strapi: Core.Strapi, args: any): Promise<string> {
  const username = String(args?.username || '').trim().replace(/^@/, '');
  if (!username) return '（未提供用户名）';
  const user: any = await strapi.db.query('plugin::users-permissions.user').findOne({
    where: { username },
    select: ['id', 'username', 'level', 'exp'],
    populate: { author: { select: ['name', 'bio'] } },
  });
  if (!user) return `没有找到用户「${username}」。`;
  const name = user.author?.name || user.username;
  const parts = [`用户：${name}（@${user.username}）`, `等级：Lv.${user.level ?? 0}`];
  if (user.author?.bio) parts.push(`简介：${String(user.author.bio).slice(0, 200)}`);
  return parts.join('\n');
}

async function toolGetPostContent(strapi: Core.Strapi, args: any): Promise<string> {
  const documentId = String(args?.document_id || '').trim();
  if (!documentId) return '（未提供帖子 document_id）';
  const article: any = await strapi.db.query('api::article.article').findOne({
    where: { documentId },
    select: ['title', 'text'],
  });
  if (!article) return `没有找到帖子（document_id: ${documentId}）。`;
  const title = article.title || '（无标题）';
  const body = String(article.text || '').slice(0, 4000);
  return `帖子标题：${title}\n帖子正文：${body}`;
}

/** 评论正文裁剪上限（喂回 LLM 的预览，不是完整存档）。 */
const COMMENT_PREVIEW_LEN = 160;
/** 单次最多展示的顶层评论数。 */
const MAX_TOP_COMMENTS = 20;
/** 每条顶层评论下最多展示的楼中楼回复数。 */
const MAX_REPLIES_PER_COMMENT = 3;

/** 评论作者展示名：匿名评论按 seed 派生匿名名，避免暴露真实身份。 */
function commentAuthorName(c: any): string {
  if (c?.isAnonymous) return buildAnonymousName(c?.anonymousSeed);
  return c?.author?.name || c?.author?.user?.username || '用户';
}

/** 评论正文 → 纯文本预览：mention token 转 @名、压缩空白、截断。 */
function commentPreview(content: unknown): string {
  return stripMentionsToPlain(String(content || ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COMMENT_PREVIEW_LEN);
}

async function toolGetPostComments(strapi: Core.Strapi, args: any): Promise<string> {
  const documentId = String(args?.document_id || '').trim();
  if (!documentId) return '（未提供帖子 document_id）';

  const article: any = await strapi.db.query('api::article.article').findOne({
    where: { documentId },
    select: ['title'],
  });
  if (!article) return `没有找到帖子（document_id: ${documentId}）。`;

  const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), MAX_TOP_COMMENTS);
  // 与 comment.listLite 一致：顶层评论 = parent 为空；楼中楼经 replies 关系取出。
  const where = {
    article: { documentId },
    parent: { documentId: { $null: true } },
  };

  const [topComments, total] = await Promise.all([
    strapi.db.query('api::comment.comment').findMany({
      where,
      orderBy: [{ likescount: 'desc' }, { createdAt: 'desc' }],
      limit,
      // anonymousSeed 在 schema 里是 private，用 db.query 才能取到（见 comment.listLite）。
      select: ['content', 'createdAt', 'likescount', 'isAnonymous', 'anonymousSeed'],
      populate: {
        author: { select: ['name'], populate: { user: { select: ['username'] } } },
        replies: {
          orderBy: { createdAt: 'asc' },
          select: ['content', 'likescount', 'isAnonymous', 'anonymousSeed'],
          populate: {
            author: { select: ['name'], populate: { user: { select: ['username'] } } },
          },
        },
      },
    }),
    strapi.db.query('api::comment.comment').count({ where }),
  ]);

  const title = article.title || '（无标题）';
  if (!Array.isArray(topComments) || topComments.length === 0) {
    return `帖子《${title}》目前还没有评论。`;
  }

  const lines: string[] = [
    `帖子《${title}》共有 ${total} 条顶层评论，按热度展示前 ${topComments.length} 条（含部分楼中楼回复）：`,
  ];
  topComments.forEach((c: any, i: number) => {
    const likes = Number(c?.likescount) || 0;
    lines.push(`${i + 1}. ${commentAuthorName(c)}：${commentPreview(c?.content)}（赞${likes}）`);
    const replies = Array.isArray(c?.replies) ? c.replies : [];
    for (const r of replies.slice(0, MAX_REPLIES_PER_COMMENT)) {
      lines.push(`   └ ${commentAuthorName(r)}：${commentPreview(r?.content)}`);
    }
  });
  return lines.join('\n');
}

export async function executeAgentTool(
  strapi: Core.Strapi,
  name: string,
  args: any,
): Promise<string> {
  switch (name) {
    case 'search_posts':
      return toolSearchPosts(strapi, args);
    case 'get_hot_posts':
      return toolGetHotPosts(strapi, args);
    case 'get_user_info':
      return toolGetUserInfo(strapi, args);
    case 'get_post_content':
      return toolGetPostContent(strapi, args);
    case 'get_post_comments':
      return toolGetPostComments(strapi, args);
    default:
      return `未知工具：${name}`;
  }
}
