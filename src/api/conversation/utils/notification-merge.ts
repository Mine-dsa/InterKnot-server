import type { Core } from '@strapi/strapi';
/**
 * notification-merge —— 把「敲敲通知」融合到 DM 会话视图
 *
 * 设计目标：
 *   把 notification 表（点赞/收藏/评论/回复/@/系统）按 sender 聚合，与现有
 *   DM 会话列表合并，使 KnockKnockModal 的私聊 tab 可以同时承载真实 DM
 *   和「按 sender 维度聚合的通知」。这样不必维护两套 IM 入口。
 *
 * 关键不变量：
 *   1. 不修改 notification 表本身（schema / lifecycle 保持原状）
 *   2. notification 不写入 message 表；序列化阶段虚构 `kind: 'notification'`
 *      的 DmMessage 给前端
 *   3. pseudo conversation：当 sender 还没和 self 开 DM 时，列表项 documentId
 *      用 `pseudo:user:${userId}` 占位；前端选中后只能看通知历史，要发消息
 *      时才走 /api/dm/conversations/direct 把会话「实质化」。这样避免单纯
 *      被通知就向 DM 表里写垃圾会话。
 *
 * 与原 /api/knock/conversations 的关系：
 *   /api/knock/conversations 仍可用、仍是 SSE 推送。本 helper 复用它的
 *   分类语义（classifyNotification）和序列化（serializeNotifications），
 *   只是在 /api/dm/* 的输出里把通知额外塞进去。
 */
import {
  classifyNotification,
  type DecodedConversationId,
  CONTACT_BUCKET_TYPES,
} from '../../notification/utils/conversation';
import {
  serializeNotifications,
  type SerializedNotification,
} from '../../notification/utils/serialize';
import { stripMentionsToPlain } from '../../comment/utils/mention';
import { buildAnonymousName } from '../../../utils/anonymous';
import { withSmallWebp, batchResolveEquippedAvatars } from '../../../utils/common';

/**
 * 单次扫描通知的最大行数。
 *
 * 之前 5000 太激进——/api/dm/conversations 与 /api/dm/conversations/:id/messages
 * 每次冷请求都拉满 5000 + 4 个 populate（sender / Article / Comment / cover）。
 * 单用户活跃通知极少超过几百条，老通知用户也不会回头翻——降到 500 显著减
 * DB IO + 序列化耗时，对前台体感没有影响。
 *
 * 如果某用户确实有超过 500 条未消化通知，第一屏聚合可能丢一些老桶，但前端
 * 也不会暴露这部分（pseudo:user 桶按 sender 聚合，新通知到达时桶会重生）。
 */
export const NOTIF_MERGE_AGGREGATE_CAP = 500;

/* ─────────────────────── pseudo id 编码 ─────────────────────── */

export const PSEUDO_USER_PREFIX = 'pseudo:user:';
export const PSEUDO_ANON_PREFIX = 'pseudo:anonymous:';
export const PSEUDO_SYSTEM_ID = 'pseudo:system';

export type PseudoConvKind = 'user' | 'anonymous' | 'system';

export interface DecodedPseudoId {
  kind: PseudoConvKind;
  /** kind === 'user' 时是 userId（number 字符串），kind === 'anonymous' 时是 seed，system 时为 '' */
  key: string;
}

export const encodePseudoUserConvId = (userId: number): string =>
  `${PSEUDO_USER_PREFIX}${userId}`;

export const encodePseudoAnonConvId = (seed: string): string =>
  `${PSEUDO_ANON_PREFIX}${seed}`;

export const isPseudoConvId = (raw: unknown): raw is string => {
  if (typeof raw !== 'string') return false;
  return (
    raw.startsWith(PSEUDO_USER_PREFIX) ||
    raw.startsWith(PSEUDO_ANON_PREFIX) ||
    raw === PSEUDO_SYSTEM_ID
  );
};

export const decodePseudoConvId = (raw: unknown): DecodedPseudoId | null => {
  if (typeof raw !== 'string') return null;
  if (raw === PSEUDO_SYSTEM_ID) return { kind: 'system', key: '' };
  if (raw.startsWith(PSEUDO_USER_PREFIX)) {
    const key = raw.slice(PSEUDO_USER_PREFIX.length);
    if (!/^\d+$/.test(key)) return null;
    return { kind: 'user', key };
  }
  if (raw.startsWith(PSEUDO_ANON_PREFIX)) {
    const key = raw.slice(PSEUDO_ANON_PREFIX.length);
    if (!key) return null;
    return { kind: 'anonymous', key };
  }
  return null;
};

/* ─────────────────────── 通知拉取 ─────────────────────── */

/**
 * 拉取指定用户收到的全部通知（含 sender / Article / Comment populate）。
 * - 用 db.query 而非 entityService —— Comment.anonymousSeed 是 private 字段，
 *   entityService 的 fields 校验会拒掉 populate
 * - 默认按 createdAt desc，取前 NOTIF_MERGE_AGGREGATE_CAP 条
 * - 调用方按需在 JS 侧再过滤 / 分桶
 */
export const fetchNotificationsForUser = async (
  strapi: Core.Strapi,
  recipientUserId: number,
  options: {
    /** 仅取来自指定 sender 的通知（contacts 桶用） */
    senderUserId?: number;
    /** 仅取匿名通知，且 anonymousSeed 等于该值 */
    anonymousSeed?: string;
    /** 仅取 system 通知 */
    systemOnly?: boolean;
    /** 仅未读（用于 mark-read） */
    unreadOnly?: boolean;
    /** 自定义上限；默认 NOTIF_MERGE_AGGREGATE_CAP */
    limit?: number;
  } = {},
): Promise<any[]> => {
  if (!Number.isInteger(recipientUserId)) return [];

  const where: any = { recipient: { id: recipientUserId } };
  if (options.unreadOnly) where.isRead = false;
  if (Number.isInteger(options.senderUserId)) {
    where.sender = { id: options.senderUserId };
    // contacts 桶里允许 like/favorite/comment/reply/mention；anonymous 评论被
    // 调用方在 JS 侧用 classifyNotification 二次过滤，这里 SQL 不必排除
  }
  if (options.systemOnly) {
    where.type = 'system';
  }
  // anonymousSeed 过滤需要 Comment.isAnonymous=true 且 Comment.anonymousSeed=seed
  if (options.anonymousSeed) {
    where.Comment = { isAnonymous: true, anonymousSeed: options.anonymousSeed };
    where.type = { $in: ['comment', 'reply', 'mention'] };
  }

  const limit = Math.max(1, options.limit ?? NOTIF_MERGE_AGGREGATE_CAP);

  return strapi.db.query('api::notification.notification').findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    limit,
    select: ['id', 'documentId', 'type', 'isRead', 'createdAt'],
    populate: {
      sender: {
        select: ['id', 'username', 'level'],
        populate: {
          author: {
            select: ['documentId', 'name'],
            populate: { avatar: { select: ['url', 'width', 'height'] } },
          },
        },
      },
      Article: {
        select: ['id', 'documentId', 'title'],
        populate: { cover: { select: ['width', 'height'] } },
      },
      Comment: {
        select: ['id', 'documentId', 'content', 'isAnonymous', 'anonymousSeed'],
        populate: {
          article: {
            select: ['documentId', 'title'],
            populate: { cover: { select: ['width', 'height'] } },
          },
        },
      },
    },
  });
};

/* ─────────────────────── 分桶 ─────────────────────── */

/** 一个通知聚合桶 */
export interface NotificationBucket {
  /**
   * 桶分类：与 classifyNotification 输出对齐
   * - contacts: 真实 sender 给当前用户的所有 like/favorite/comment/reply/mention
   * - anonymous: 匿名评论，按 anonymousSeed 聚合
   * - other: 系统消息（仅 system 一桶）
   */
  decoded: DecodedConversationId;
  /** 该桶内未读通知数 */
  unread: number;
  /** 桶内最新一条通知（用于列表预览 + lastMessageAt） */
  latest: any;
  /** 桶内通知 raw 数组（按 createdAt desc） */
  rows: any[];
}

/**
 * 把 raw 通知按 (category, peerKey) 分桶。
 * 调用方拿到 buckets 之后可：
 *  - bucketToSummary 转 DmConversationSummary（用于 list 输出）
 *  - 或按 bucket 拉出全部 rows 做消息流融合
 */
export const groupNotifications = (rows: any[]): Map<string, NotificationBucket> => {
  const buckets = new Map<string, NotificationBucket>();
  for (const item of rows) {
    const decoded = classifyNotification({
      type: item?.type,
      sender: item?.sender ?? null,
      Comment: item?.Comment ?? null,
    });
    if (!decoded) continue;
    const key = `${decoded.category}:${decoded.peerKey}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { decoded, unread: 0, latest: item, rows: [] };
      buckets.set(key, bucket);
    }
    bucket.rows.push(item);
    if (!item.isRead) bucket.unread += 1;
    // rows 是 desc 排序传入的，所以 latest 一直是首个非空元素
    if (!bucket.latest || item.createdAt > bucket.latest.createdAt) {
      bucket.latest = item;
    }
  }
  return buckets;
};

/* ─────────────────────── 桶 → ConversationSummary ─────────────────────── */

/** 列表预览文案（与 notification controller 的 previewOf 同口径） */
const previewOfNotification = (item: any): string => {
  if (item?.type === 'like') {
    return item?.Comment ? '赞了你的评论' : '赞了你的帖子';
  }
  if (item?.type === 'favorite') return '收藏了你的帖子';
  if (item?.type === 'denny') return '给你的帖子投了币';
  if (item?.Comment?.content) return stripMentionsToPlain(item.Comment.content);
  if (item?.type === 'system') return '系统消息';
  return '';
};

/** 单桶 peer 信息（contacts 取真实 sender，anonymous 用 seed 派生匿名 ID，system 走系统占位） */
const derivePseudoPeer = (
  bucket: NotificationBucket,
  senderAvatarMap: Map<number, any>,
): {
  pseudoKind: PseudoConvKind;
  pseudoConvId: string;
  peerUserId: number | null;
  peerName: string;
  peerAvatar: string | null;
  peerLevel: number | null;
  peerAuthorDocumentId: string | null;
} => {
  const { decoded } = bucket;
  if (decoded.category === 'anonymous') {
    return {
      pseudoKind: 'anonymous',
      pseudoConvId: encodePseudoAnonConvId(decoded.peerKey),
      peerUserId: null,
      peerName: buildAnonymousName(decoded.peerKey),
      peerAvatar: null,
      peerLevel: null,
      peerAuthorDocumentId: null,
    };
  }
  if (decoded.category === 'other') {
    return {
      pseudoKind: 'system',
      pseudoConvId: PSEUDO_SYSTEM_ID,
      peerUserId: null,
      peerName: '系统消息',
      peerAvatar: null,
      peerLevel: null,
      peerAuthorDocumentId: null,
    };
  }
  // contacts：从 latest 通知里取 sender 信息
  const senderId = Number.parseInt(decoded.peerKey, 10);
  const sender = bucket.latest?.sender;
  const author = sender?.author;
  let avatarUrl: string | null = null;
  if (Number.isInteger(senderId) && senderAvatarMap.has(senderId)) {
    const equipped = withSmallWebp(senderAvatarMap.get(senderId));
    avatarUrl = equipped?.url ?? null;
  } else if (author?.avatar?.url) {
    const wrapped = withSmallWebp(author.avatar);
    avatarUrl = wrapped?.url ?? null;
  }
  return {
    pseudoKind: 'user',
    pseudoConvId: encodePseudoUserConvId(senderId),
    peerUserId: senderId,
    peerName: author?.name || sender?.username || '未知用户',
    peerAvatar: avatarUrl,
    peerLevel: sender?.level ?? null,
    peerAuthorDocumentId: author?.documentId ?? null,
  };
};

/**
 * 把桶转成 DmConversationSummary 形态（pseudo 会话项）。
 * 用于 list controller 把通知 sender 当作伪 DM 项展示。
 */
export const bucketToSummary = (
  bucket: NotificationBucket,
  senderAvatarMap: Map<number, any>,
): any => {
  const peer = derivePseudoPeer(bucket, senderAvatarMap);
  const latest = bucket.latest;
  const lastPreview = previewOfNotification(latest);

  return {
    documentId: peer.pseudoConvId,
    kind: 'direct', // 视觉与 direct 一致；前端按 pseudoKind 区分能力
    title: null,
    avatar: null,
    peer:
      peer.peerUserId != null
        ? {
            userId: peer.peerUserId,
            authorDocumentId: peer.peerAuthorDocumentId,
            name: peer.peerName,
            avatar: peer.peerAvatar,
            level: peer.peerLevel,
          }
        : {
            // anonymous / system 无 userId，但前端列表项渲染需要 peer.name + peer.avatar
            userId: null,
            authorDocumentId: null,
            name: peer.peerName,
            avatar: peer.peerAvatar,
            level: null,
          },
    memberCount: 2,
    lastMessageAt: latest?.createdAt ?? null,
    lastMessage: latest
      ? {
          documentId: `notif:${latest.documentId}`,
          content: lastPreview,
          createdAt: latest.createdAt,
          kind: 'notification',
          senderUserId: peer.peerUserId,
        }
      : null,
    unreadCount: bucket.unread,
    self: {
      role: 'member',
      muted: false,
      pinned: false,
      lastReadAt: null,
    },
    pseudoKind: peer.pseudoKind,
  };
};

/* ─────────────────────── 通知 → DmMessage ─────────────────────── */

/** 把单条 serialized notification 转成 DmMessage 形态
 *
 * `content` 字段是「列表预览/纯文本兜底」：
 *  - 互动类（like / favorite）固定文案（comment.content 是被赞的我自己写的，不能当 sender 的发言展示）
 *  - mention / system 固定文案
 *  - comment / reply 取评论原文，但**剥离 mention token**（避免列表预览里出现 `@[name](id)`）
 *
 * 富文本（含 mention 高亮）渲染由前端通过 `comment.content`（raw，未剥离 token）走 `CommentBody` 完成。
 */
export const notificationToDmMessage = (
  notif: SerializedNotification,
): any => {
  const sender = (notif.sender ?? null) as {
    id?: number;
    username?: string;
    level?: number;
    author?: {
      documentId?: string;
      name?: string;
      avatar?: { url?: string } | string | null;
    } | null;
  } | null;
  const senderUserId = sender?.id ?? null;
  const senderAuthor = sender?.author ?? null;

  let plainContent = '';
  if (notif.type === 'like') {
    plainContent = notif.comment ? '赞了你的评论' : '赞了你的帖子';
  } else if (notif.type === 'favorite') {
    plainContent = '收藏了你的帖子';
  } else if (notif.type === 'denny') {
    plainContent = '给你的帖子投了币';
  } else if (notif.type === 'mention') {
    plainContent = '在帖子中提到了你';
  } else if (notif.type === 'system') {
    plainContent = '系统消息';
  } else if (notif.type === 'comment' || notif.type === 'reply') {
    plainContent = notif.comment?.content
      ? stripMentionsToPlain(notif.comment.content)
      : '';
  }

  return {
    documentId: `notif:${notif.documentId}`,
    kind: 'notification',
    content: plainContent,
    createdAt: notif.createdAt,
    editedAt: null,
    deletedAt: null,
    sender: sender
      ? {
          userId: senderUserId,
          authorDocumentId: senderAuthor?.documentId ?? null,
          name: senderAuthor?.name ?? sender?.username ?? '未知用户',
          avatar:
            (typeof senderAuthor?.avatar === 'string'
              ? senderAuthor?.avatar
              : senderAuthor?.avatar?.url) ?? null,
          level: sender?.level ?? null,
        }
      : null,
    replyTo: null,
    // notification-only fields
    notificationKind: notif.type,
    notificationDocumentId: notif.documentId,
    notificationRead: notif.isRead,
    article: notif.article ?? null,
    // raw content（含 mention token），前端 CommentBody 渲染富文本
    comment: notif.comment ?? null,
  };
};

/* ─────────────────────── 高阶：mark-read 辅助 ─────────────────────── */

/**
 * 把指定桶（user/anonymous/system）下的所有未读通知标为已读。
 * 返回更新条数；调用方负责 SSE / 缓存 invalidate。
 */
export const markBucketNotificationsRead = async (
  strapi: Core.Strapi,
  recipientUserId: number,
  pseudo: DecodedPseudoId | { kind: 'contacts-user'; senderUserId: number },
): Promise<number> => {
  // Strapi db.query.updateMany 不支持嵌套关联表的 where 条件
  // （如 recipient: { id: ... }, sender: { id: ... }），
  // 必须先 findMany 取出匹配的 id 列表，再用 id.$in 批量更新。
  let findWhere: any;
  let postFilter: ((rows: any[]) => number[]) | null = null;

  if ((pseudo).kind === 'system') {
    findWhere = {
      recipient: { id: recipientUserId },
      isRead: false,
      type: 'system',
    };
  } else if ((pseudo).kind === 'anonymous') {
    findWhere = {
      recipient: { id: recipientUserId },
      isRead: false,
      type: { $in: ['comment', 'reply', 'mention'] },
    };
    const seed = (pseudo as DecodedPseudoId).key;
    postFilter = (rows) =>
      rows
        .filter((r) => r?.Comment?.isAnonymous === true && r?.Comment?.anonymousSeed === seed)
        .map((r) => r.id)
        .filter((id) => Number.isInteger(id));
  } else if ((pseudo).kind === 'user') {
    const senderUserId = Number.parseInt((pseudo as DecodedPseudoId).key, 10);
    if (!Number.isInteger(senderUserId) || senderUserId <= 0) return 0;
    findWhere = {
      recipient: { id: recipientUserId },
      isRead: false,
      sender: { id: senderUserId },
      type: { $in: [...CONTACT_BUCKET_TYPES] },
    };
  } else if ((pseudo).kind === 'contacts-user') {
    const senderUserId = (pseudo as { senderUserId: number }).senderUserId;
    if (!Number.isInteger(senderUserId) || senderUserId <= 0) return 0;
    findWhere = {
      recipient: { id: recipientUserId },
      isRead: false,
      sender: { id: senderUserId },
      type: { $in: [...CONTACT_BUCKET_TYPES] },
    };
  } else {
    return 0;
  }

  const candidates = await strapi.db
    .query('api::notification.notification')
    .findMany({
      where: findWhere,
      select: ['id'],
      // anonymous 分支需要 Comment 字段做 JS 二次过滤
      populate: postFilter
        ? { Comment: { select: ['isAnonymous', 'anonymousSeed'] } }
        : {},
      limit: 500,
    });

  const ids = postFilter
    ? postFilter(candidates)
    : candidates.map((r) => r.id).filter((id) => Number.isInteger(id));

  if (ids.length === 0) return 0;

  const result = (await strapi.db
    .query('api::notification.notification')
    .updateMany({ where: { id: { $in: ids } }, data: { isRead: true } })) as { count?: number } | undefined;
  return result?.count ?? 0;
};

/* ─────────────────────── 高阶：list 合并 ─────────────────────── */

/**
 * 把 notification buckets 合并到 DM 会话列表。
 *
 * 规则：
 *  - contacts 桶 + DM 列表里已有该 peer 的会话 → 合并 unread / 更新 lastMessage
 *    （取较新者）
 *  - contacts 桶 + DM 列表里无该 peer → 新增 pseudo:user 项
 *  - anonymous / system 桶 → 永远新增 pseudo:* 项
 *
 * 返回统一排序后的列表（按 lastMessageAt desc）。
 */
export const mergeDmListWithNotificationBuckets = async (
  strapi: Core.Strapi,
  dmList: any[],
  buckets: Map<string, NotificationBucket>,
): Promise<any[]> => {
  const out: any[] = [];

  // 收集 contacts 桶里所有 senderUserId，批量解析装备头像
  const contactsSenderIds: number[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.decoded.category === 'contacts') {
      const sid = Number.parseInt(bucket.decoded.peerKey, 10);
      if (Number.isInteger(sid)) contactsSenderIds.push(sid);
    }
  }
  const senderAvatarMap = contactsSenderIds.length
    ? await batchResolveEquippedAvatars(strapi, contactsSenderIds)
    : new Map<number, any>();

  // 先复制 dm 列表（保证不变性），按 peer.userId 建索引
  const peerToDm = new Map<number, any>();
  for (const conv of dmList) {
    out.push(conv);
    const pid = conv?.peer?.userId;
    if (Number.isInteger(pid)) peerToDm.set(pid, conv);
  }

  for (const bucket of buckets.values()) {
    const { decoded, latest } = bucket;
    if (decoded.category === 'contacts') {
      const senderId = Number.parseInt(decoded.peerKey, 10);
      const dmConv = Number.isInteger(senderId) ? peerToDm.get(senderId) : null;
      if (dmConv) {
        // 合并：unread 累加；lastMessage 取较新
        dmConv.unreadCount = (dmConv.unreadCount || 0) + bucket.unread;
        const dmLastAt = dmConv.lastMessageAt ?? '';
        const notifLastAt = latest?.createdAt ?? '';
        if (notifLastAt && notifLastAt > dmLastAt) {
          dmConv.lastMessageAt = notifLastAt;
          dmConv.lastMessage = {
            documentId: `notif:${latest.documentId}`,
            content: previewOfNotification(latest),
            createdAt: latest.createdAt,
            kind: 'notification',
            senderUserId: senderId,
          };
        }
        continue;
      }
    }
    // 新建 pseudo 项
    out.push(bucketToSummary(bucket, senderAvatarMap));
  }

  // 排序：按 lastMessageAt desc，无值放最后
  out.sort((a, b) => {
    const aT = a.lastMessageAt ?? '';
    const bT = b.lastMessageAt ?? '';
    if (aT && bT) return aT < bT ? 1 : aT > bT ? -1 : 0;
    if (aT && !bT) return -1;
    if (!aT && bT) return 1;
    return 0;
  });

  return out;
};

/* ─────────────────────── 高阶：messages 合并 ─────────────────────── */

/**
 * 在真 DM 会话的消息流里追加该会话 peer 给 self 的 notifications。
 *
 * **顺序契约**：与 message.list 返回前端的格式对齐——createdAt **desc**。
 * 前端 useDmConversations.toAsc 会做最终反转得到展示用的 asc。
 *
 * 入参 dmMessages 是 desc；notifRows 也是 desc；merge 后按 desc 排序返回。
 *
 * 注意：本函数不做分页 cursor 处理。调用方若需要分页，自己控制时间窗口。
 */
export const mergeDmMessagesWithNotifications = async (
  strapi: Core.Strapi,
  dmMessages: any[],
  notifRows: any[],
): Promise<any[]> => {
  if (!notifRows.length) return dmMessages;
  const serialized = await serializeNotifications(strapi, notifRows);
  const notifMessages = serialized.map(notificationToDmMessage);
  const merged = [...dmMessages, ...notifMessages];
  merged.sort((a, b) => {
    const aT = a.createdAt ?? '';
    const bT = b.createdAt ?? '';
    // desc：新消息在前
    return aT > bT ? -1 : aT < bT ? 1 : 0;
  });
  return merged;
};
