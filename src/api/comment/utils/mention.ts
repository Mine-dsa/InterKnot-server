import type { Core } from '@strapi/strapi';
/**
 * Mention token 解析工具（后端）。
 *
 * 评论正文里的 @ 提及以 markdown-style 标记存储：
 *   `@[显示名](authorDocumentId)`
 *
 * 设计要点：
 * - 显示名快照写入：被 @ 的用户改名后老评论里仍展示当时的名字。
 * - authorDocumentId 是项目通用的稳定标识符，便于跳转主页 / 创建通知。
 * - 显示名长度上限 40：与 author.name 列实际宽度匹配，防止恶意超长 token。
 * - documentId 只允许 [A-Za-z0-9]，长度 6~32：贴合 Strapi 默认 documentId 形态。
 *
 * 与 `app/utils/mention.ts` 的正则 / 行为应保持一致。两端独立维护避免跨仓引用。
 */

export const MENTION_REGEX = /@\[([^\[\]\n]{1,40})\]\(([A-Za-z0-9]{6,32})\)/g;

export interface MentionToken {
  /** token 内书写的显示名（只用于回显，不做权威字段） */
  name: string;
  /** 被 @ 的 author.documentId */
  authorDocumentId: string;
  /** token 在原字符串中的起止下标（半开区间） */
  start: number;
  end: number;
}

/**
 * 解析评论正文里的所有 mention token。
 * 返回顺序与出现顺序一致；不去重（去重交给调用方按业务语义处理）。
 */
export const parseMentions = (content: string): MentionToken[] => {
  if (typeof content !== 'string' || !content) return [];
  // RegExp 是带 /g 的全局正则，必须先重置 lastIndex 再用，否则多次调用结果会漂。
  const re = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);
  const out: MentionToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({
      name: m[1] ?? '',
      authorDocumentId: m[2] ?? '',
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
};

/**
 * 把所有 mention token 替换成 `@显示名` 形式，给会话列表 / 摘要预览用。
 * 不做 HTML 转义（调用方按需处理）。
 */
export const stripMentionsToPlain = (content: string): string => {
  if (typeof content !== 'string' || !content) return '';
  return content.replace(
    new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags),
    (_match, name: string) => `@${name}`,
  );
};

/**
 * 提取 mention token 中独立的 authorDocumentId 集合，保留首次出现顺序。
 * 用于通知派发时按目标用户去重。
 */
export const collectMentionedDocumentIds = (
  content: string,
  cap = 10,
): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of parseMentions(content)) {
    const id = t.authorDocumentId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
};

/**
 * 「裸 @」识别正则。字符集合与前端 useMentionInput.QUERY_RE 一致：
 *   文字 / 数字 / 下划线 / 短横线。
 * 之所以不复用 MENTION_REGEX 取反——MENTION_REGEX 只识别完整 token，
 * 我们要的是 token 之外的 `@<word>` 形态。
 */
const PLAIN_MENTION_RE = /@([\p{L}\p{N}_\-]+)/gu;

/** 一次性算出所有 token 区间，便于在裸 @ 扫描时排除掉它们 */
const computeTokenRanges = (content: string): Array<[number, number]> =>
  parseMentions(content).map((t) => [t.start, t.end]);

/**
 * 找出 content 里**不在已有 token 内**的裸 `@<word>` 候选词集合。
 * 这些词稍后会与 user.username / author.name 双路精确匹配。
 * 保留首次出现顺序，去重。
 */
export const findPlainMentionTokens = (content: string): string[] => {
  if (typeof content !== 'string' || !content) return [];
  const ranges = computeTokenRanges(content);
  const inToken = (idx: number) => ranges.some(([s, e]) => idx >= s && idx < e);
  const re = new RegExp(PLAIN_MENTION_RE.source, PLAIN_MENTION_RE.flags);
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (inToken(m.index)) continue;
    const word = m[1] ?? '';
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
};

/**
 * 把 content 里「裸 `@xxx`」展开为规范化的 `@[name](docId)` token。
 *
 * 解析口径：
 * - 同时按 **`user.username`** 和 **`author.name`** 精确等值匹配（OR）。
 *   - username 在 users-permissions 唯一，命中即唯一目标。
 *   - author.name 理论上可重复——同一候选词在 name 维度匹配到 ≥2 个不同用户时
 *     视为「歧义」，保留原文不改写，避免误伤。
 *   - 同一候选词同时命中 username 与 name（且指向不同用户）也视为歧义跳过。
 * - 一次 SQL 查询批量解析，无 N+1。
 * - 屏蔽 `blocked: true` 的账号——不应被自动 @ 出去。
 * - 已是 token 的段原样保留（通过 token 区间排除避免重复改写）。
 * - 没匹配到时原样不动，普通文本照常显示。
 *
 * 用在 comment lifecycle.beforeCreate：写库前展开，下游 notifyMentions / 前端
 * CommentBody 渲染都拿到规范化串，不需要分支处理「裸 @」与「token」两种形态。
 */
export const expandPlainMentions = async (
  content: string,
  strapi: Core.Strapi,
): Promise<string> => {
  if (typeof content !== 'string' || !content) return content || '';
  const candidates = findPlainMentionTokens(content);
  if (candidates.length === 0) return content;

  // username + author.name 双路 OR；用 author 关系的过滤条件避开两次往返
  const users = await strapi.db
    .query('plugin::users-permissions.user')
    .findMany({
      where: {
        blocked: { $ne: true },
        $or: [
          { username: { $in: candidates } },
          { author: { name: { $in: candidates } } },
        ],
      },
      select: ['id', 'username'],
      populate: { author: { select: ['documentId', 'name'] } },
    });

  if (!users || users.length === 0) return content;

  // 候选词 → 命中目标列表。同一候选可能从 username / name 两边都命中。
  // 用 documentId 去重（避免同一用户被算两次），≥2 个不同 docId 视为歧义。
  type Target = { documentId: string; name: string };
  const buckets = new Map<string, Map<string, Target>>();
  const recordHit = (key: string, target: Target) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new Map();
      buckets.set(key, bucket);
    }
    if (!bucket.has(target.documentId)) {
      bucket.set(target.documentId, target);
    }
  };

  const candidateSet = new Set(candidates);
  for (const u of users) {
    const docId = u?.author?.documentId;
    if (!docId) continue;
    const target: Target = {
      documentId: docId,
      name: u?.author?.name || u?.username || '',
    };
    if (typeof u.username === 'string' && candidateSet.has(u.username)) {
      recordHit(u.username, target);
    }
    const authorName = u?.author?.name;
    if (typeof authorName === 'string' && candidateSet.has(authorName)) {
      recordHit(authorName, target);
    }
  }

  // 只保留唯一命中的候选词
  const resolveMap = new Map<string, Target>();
  for (const [key, bucket] of buckets) {
    if (bucket.size === 1) {
      resolveMap.set(key, bucket.values().next().value as Target);
    }
    // bucket.size >= 2：歧义，保留原文不展开
  }
  if (resolveMap.size === 0) return content;

  // 二次扫描完整文本，把命中段替换为 token，未命中段原样保留。
  // 注意：替换会改变后续下标，所以用 cursor 滚动 + slice 拼接，不能直接 String.replace。
  const ranges = computeTokenRanges(content);
  const inToken = (idx: number) => ranges.some(([s, e]) => idx >= s && idx < e);
  const re = new RegExp(PLAIN_MENTION_RE.source, PLAIN_MENTION_RE.flags);

  let result = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (inToken(m.index)) continue;
    const word = m[1] ?? '';
    const target = resolveMap.get(word);
    if (!target) continue;
    const start = m.index;
    const end = start + m[0].length;
    result += content.slice(cursor, start);
    result += `@[${target.name}](${target.documentId})`;
    cursor = end;
  }
  result += content.slice(cursor);
  return result;
};
