/**
 * 敲敲会话工具：会话 id 编解码 + 把会话 id 还原为 entityService 的 where 条件。
 *
 * 会话本身不是数据库表，而是按 (category, peerKey) 对 notification 表做的虚拟分组：
 *   - contacts  : 评论类（非匿名）+ 交互类（like/favorite/denny）→ peerKey = sender.id
 *   - anonymous : 评论类 且 Comment.isAnonymous = true     → peerKey = Comment.anonymousSeed
 *   - other     : 系统消息                                  → peerKey = "system"
 *
 * 设计取舍：
 * - like/favorite/denny 也归 contacts，让"用户 X 给你的点赞 / 投币 / 评论"出现在同一个会话流里
 *   （类比微信"用户 X 给你的所有动作"集中显示）
 * - like 的 sender 永远是真实用户（不可能匿名），所以 INTERACT_TYPES 不走匿名分支
 * - Comment.isAnonymous 在 like-on-comment 场景下指的是「被点赞的那条评论」是否匿名，
 *   跟点赞者本身的身份无关，因此交互类不参考这个字段
 */

export const KNOCK_CATEGORIES = ['contacts', 'anonymous', 'other'] as const;
export type KnockCategory = (typeof KNOCK_CATEGORIES)[number];

export const SYSTEM_PEER_KEY = 'system';

/** 评论类：comment/reply/mention —— 可走匿名分支 */
const NORMAL_TYPES = ['comment', 'reply', 'mention'] as const;
/** 交互类：like/favorite/denny —— 永远归 contacts，按 sender 分组 */
const INTERACT_TYPES = ['like', 'favorite', 'denny'] as const;
/** 系统消息 */
const SYSTEM_TYPES = ['system'] as const;

/** contacts 桶里允许的所有类型（评论 + 交互），作为唯一真相源导出 */
export const CONTACT_BUCKET_TYPES = [...NORMAL_TYPES, ...INTERACT_TYPES] as const;

const isCategory = (v: unknown): v is KnockCategory =>
  typeof v === 'string' && (KNOCK_CATEGORIES as readonly string[]).includes(v);

/**
 * 把 (category, peerKey) 编码为 URL-safe 会话 id。
 * peerKey 用 base64url 包装一下，避免冒号/斜杠等出现在路径里。
 */
export const encodeConversationId = (
  category: KnockCategory,
  peerKey: string,
): string => `${category}:${Buffer.from(peerKey, 'utf8').toString('base64url')}`;

export interface DecodedConversationId {
  category: KnockCategory;
  peerKey: string;
}

/** 解码失败返回 null，调用方负责返回 400/404 */
export const decodeConversationId = (
  raw: unknown,
): DecodedConversationId | null => {
  if (typeof raw !== 'string') return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const category = raw.slice(0, idx);
  const peerB64 = raw.slice(idx + 1);
  if (!isCategory(category) || !peerB64) return null;
  try {
    const peerKey = Buffer.from(peerB64, 'base64url').toString('utf8');
    if (!peerKey) return null;
    return { category, peerKey };
  } catch {
    return null;
  }
};

/**
 * 由会话标识构造一份 entityService.findMany 用的 filters。
 * 始终带上 recipient 限制，保证调用方不会越权读到他人的会话。
 */
export const buildConversationWhere = (
  recipientId: number,
  decoded: DecodedConversationId,
): Record<string, unknown> => {
  const base: Record<string, unknown> = { recipient: { id: recipientId } };

  if (decoded.category === 'anonymous') {
    // 只有评论类才能匿名，交互类（like/favorite）的 sender 永远是真实用户
    return {
      ...base,
      type: { $in: NORMAL_TYPES },
      Comment: { isAnonymous: true, anonymousSeed: decoded.peerKey },
    };
  }

  if (decoded.category === 'contacts') {
    const senderId = Number(decoded.peerKey);
    if (!Number.isInteger(senderId) || senderId <= 0) {
      // 非法 peerKey，返回一个永远查不到记录的 where
      return { ...base, id: -1 };
    }
    // 这里不用 $not 排除匿名，因为 db.query 对带关联路径的 $not 支持不稳定。
    // 由调用方用 classifyNotification 做最后一道 JS 过滤。
    // CONTACT_BUCKET_TYPES = 评论类 + 交互类，让 like/favorite 也进入同一会话流。
    return {
      ...base,
      type: { $in: CONTACT_BUCKET_TYPES },
      sender: { id: senderId },
    };
  }

  // other：仅承接系统消息。如果以后增加 sender 为 null 的特殊通知类型，再扩展。
  if (decoded.peerKey === SYSTEM_PEER_KEY) {
    return {
      ...base,
      type: { $in: SYSTEM_TYPES },
    };
  }

  // 历史「other + senderId」的会话已不再创建（like/favorite 已迁到 contacts），
  // 但旧的 URL 可能还在；返回空结果以优雅降级，由前端兜底提示空会话。
  return { ...base, id: -1 };
};

/**
 * 把 raw 通知按 conversation 维度做最后一道 JS 过滤，确保和 listConversations 的
 * 分类逻辑完全一致（避免 SQL 端 / 内存端两套逻辑漂移）。
 */
export const matchesConversation = (
  item: {
    type?: string;
    sender?: { id?: number | null } | null;
    Comment?: { isAnonymous?: boolean | null; anonymousSeed?: string | null } | null;
  },
  decoded: DecodedConversationId,
): boolean => {
  const cls = classifyNotification(item);
  if (!cls) return false;
  return cls.category === decoded.category && cls.peerKey === decoded.peerKey;
};

/**
 * 给一条 notification（带 sender / Comment populate）计算它属于哪个会话。
 * 用于 afterCreate 钩子时无需重新查 DB。
 */
export const classifyNotification = (
  item: {
    type?: string;
    sender?: { id?: number | null } | null;
    Comment?: { isAnonymous?: boolean | null; anonymousSeed?: string | null } | null;
  },
): DecodedConversationId | null => {
  if (!item?.type) return null;

  // 评论类：先判匿名分支，再按 sender 落 contacts
  if ((NORMAL_TYPES as readonly string[]).includes(item.type)) {
    if (item.Comment?.isAnonymous) {
      const seed = item.Comment.anonymousSeed;
      if (!seed) return null;
      return { category: 'anonymous', peerKey: seed };
    }
    const senderId = item.sender?.id;
    if (!Number.isInteger(senderId)) return null;
    return { category: 'contacts', peerKey: String(senderId) };
  }

  // 交互类（like/favorite）：永远 contacts。Comment.isAnonymous 在这里指的是
  // 「被点赞的评论」是否匿名，跟点赞者无关，不参考。
  if ((INTERACT_TYPES as readonly string[]).includes(item.type)) {
    const senderId = item.sender?.id;
    if (!Number.isInteger(senderId)) return null;
    return { category: 'contacts', peerKey: String(senderId) };
  }

  // 系统消息
  if ((SYSTEM_TYPES as readonly string[]).includes(item.type)) {
    return { category: 'other', peerKey: SYSTEM_PEER_KEY };
  }

  return null;
};
