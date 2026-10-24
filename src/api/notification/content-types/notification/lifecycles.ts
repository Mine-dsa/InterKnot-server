import type { LifecycleEvent } from '../../../../types/strapi';
/**
 * notification 生命周期：
 * afterCreate 时把事件发布到 SSE 总线 + DM WS 总线，
 * 让 recipient 的在线客户端在「敲敲老接口」和「DM 融合视图」两侧都能实时收到。
 *
 * 之所以放在 notification 模型本身而不是各 lifecycle（comment/like/favorite）里，
 * 是因为：
 * - 未来新增通知来源时不必逐个更新 SSE / WS 接入点
 * - 失败不会阻断主业务（用 try/catch + setImmediate 异步发布）
 */
import { classifyNotification, encodeConversationId } from '../../utils/conversation';
import { publish } from '../../utils/sse-bus';
import { serializeNotifications } from '../../utils/serialize';
import { getRedis } from '../../../../utils/redis';
import { findExistingDirectConversation } from '../../../conversation/utils/dm-helpers';
import { dmConvListKey } from '../../../conversation/utils/dm-helpers';
import {
  encodePseudoUserConvId,
  encodePseudoAnonConvId,
  PSEUDO_SYSTEM_ID,
  notificationToDmMessage,
} from '../../../conversation/utils/notification-merge';
import { publishToUser } from '../../../conversation/utils/ws-bus';

export default {
  // 注意：这里**不能** async/await，否则主写入会被阻塞，正是我们要避免的。
  // 同步取出 result.id 然后 setImmediate 异步去 populate + publish，afterCreate 立刻返回。
  afterCreate(event: LifecycleEvent) {
    const resultId = event?.result?.id;
    if (!resultId) return;

    setImmediate(() => {
      // setImmediate 回调里抛错不会被外层 try/catch 抓到，必须自带 catch，
      // 否则会变成 unhandledRejection 让进程崩。
      publishAsync(resultId).catch((err) => {
        strapi.log?.warn?.('[knock-sse] afterCreate publish failed', err as Error);
      });
    });
  },
};

async function publishAsync(notificationId: number) {
  // 一次性 fetch 完整 populate——之前先轻量 fetch 走 SSE 再完整 fetch 走 DM ws
  // 是不必要的双查，合并成单查后 recipient / sender / Comment / Article 都齐了。
  const full: any = await strapi.db
    .query('api::notification.notification')
    .findOne({
      where: { id: notificationId },
      select: ['id', 'documentId', 'type', 'isRead', 'createdAt'],
      populate: {
        recipient: { select: ['id'] },
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

  const recipientId = full?.recipient?.id;
  if (!Number.isInteger(recipientId)) return;

  // 新通知到达后 /api/knock/conversations 与 /api/dm/conversations 的缓存都过期。
  // 失败不影响 publish 流程。
  try {
    const redis = getRedis();
    await Promise.all([
      redis.del(`knock:conv:${recipientId}`),
      redis.del(dmConvListKey(recipientId)),
    ]);
  } catch {
    /* noop */
  }

  const decoded = classifyNotification({
    type: full?.type,
    sender: full?.sender ?? null,
    Comment: full?.Comment ?? null,
  });

  // 1) 老 SSE 路径：保持兼容，前端旧 useKnockKnockConversations 还能用
  const conversationId = decoded
    ? encodeConversationId(decoded.category, decoded.peerKey)
    : undefined;
  publish(recipientId, {
    type: 'notification.created',
    conversationId,
    notificationId: full?.documentId,
    at: new Date().toISOString(),
  });

  // 2) DM WS 路径：把通知作为虚拟 DmMessage 推到 receiver 的 DM channel，
  //    让 KnockKnockModal 私聊 tab 实时收到「会话式融合通知」
  if (!decoded) return;
  await publishDmWsEvent(full, recipientId, decoded).catch((err) => {
    strapi.log?.warn?.('[dm-ws] notification → dm push failed', err as Error);
  });
}

/**
 * 把已 populate 的 notification 序列化为 DmMessage，按 conversationId
 * （real DM / pseudo）push 到 DM WS。
 */
async function publishDmWsEvent(
  full: any,
  recipientId: number,
  decoded: { category: 'contacts' | 'anonymous' | 'other'; peerKey: string },
): Promise<void> {
  const [serialized] = await serializeNotifications(strapi, [full]);
  if (!serialized) return;

  const dmMessage = notificationToDmMessage(serialized);

  // 决定 conversationId：
  // - contacts 类：若已存在 (recipient, sender) 的 direct 会话，用真 docId；
  //   否则走 pseudo:user:${senderId}
  // - anonymous：pseudo:anonymous:${seed}
  // - system：pseudo:system
  let conversationId: string;
  if (decoded.category === 'contacts') {
    const senderId = Number.parseInt(decoded.peerKey, 10);
    if (!Number.isInteger(senderId) || senderId <= 0) return;
    const existing = await findExistingDirectConversation(strapi, recipientId, senderId);
    conversationId = existing
      ? existing.documentId
      : encodePseudoUserConvId(senderId);
  } else if (decoded.category === 'anonymous') {
    conversationId = encodePseudoAnonConvId(decoded.peerKey);
  } else {
    conversationId = PSEUDO_SYSTEM_ID;
  }

  publishToUser(recipientId, {
    type: 'message.created',
    conversationId,
    messageId: dmMessage.documentId,
    data: { message: dmMessage },
    at: new Date().toISOString(),
  });
}
