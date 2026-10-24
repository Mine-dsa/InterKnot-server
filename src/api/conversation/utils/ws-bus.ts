/**
 * 进程内 WS 总线：每个 userId 维护一组 WebSocket 连接。
 *
 * 与 notification/utils/sse-bus.ts 是兄弟模块——故意不抽公共底层：
 * 1) SSE 走 Subscriber 回调（HTTP res.write）；WS 直接持有 ws 实例（ws.send）；
 *    抽象层只能拿到最小公约数，反而要在调用点做类型分支。
 * 2) DM 高频事件（typing 等）量级远大于敲敲，演化路径不同——保持解耦更稳。
 *
 * 设计取舍：
 * - 单进程；多实例时换 Redis pub/sub 即可，调用方 publish* 接口不变。
 * - per-user 多连接（多端登录）；同一 userId 超过 CONNECTIONS_PER_USER 时 FIFO 淘汰。
 */
import type { WebSocket } from 'ws';

export type DmEventType =
  | 'message.created'
  | 'message.edited'
  | 'message.delta'
  | 'message.deleted'
  | 'conversation.read'
  | 'conversation.updated'
  | 'conversation.member.added'
  | 'conversation.member.removed'
  | 'typing'
  | 'pong'
  | 'hello'
  | 'error';

export interface DmEvent {
  type: DmEventType;
  /** 涉及的 conversation documentId（前端用于路由 / 缓存 invalidation） */
  conversationId?: string;
  /** 单条 message 时的 documentId */
  messageId?: string;
  /** 主负载，按 type 不同形态不同；服务端 / 客户端各自约定。 */
  data?: unknown;
  /** ISO 时间戳，便于客户端排序 / 去重 */
  at: string;
}

const CONNECTIONS_PER_USER = 5;

const connectionsByUser = new Map<number, Set<WebSocket>>();

/**
 * 注册一条用户级连接。返回 unregister，调用一次即从 bucket 移除。
 *
 * 当 bucket 已满时按 FIFO 淘汰最老的连接（与 sse-bus 行为一致）；被淘汰的
 * 连接会被 close(1000, 'evicted')，前端可以据此提示用户。
 */
export const addWsConnection = (userId: number, ws: WebSocket): (() => void) => {
  let bucket = connectionsByUser.get(userId);
  if (!bucket) {
    bucket = new Set();
    connectionsByUser.set(userId, bucket);
  }

  while (bucket.size >= CONNECTIONS_PER_USER) {
    // Set 迭代顺序 = 插入顺序，第一个就是最老的
    const oldest = bucket.values().next().value as WebSocket | undefined;
    if (!oldest) break;
    bucket.delete(oldest);
    try {
      oldest.close(1000, 'evicted');
    } catch {
      /* noop */
    }
  }

  bucket.add(ws);

  return () => {
    const b = connectionsByUser.get(userId);
    if (!b) return;
    b.delete(ws);
    if (b.size === 0) connectionsByUser.delete(userId);
  };
};

/**
 * 把事件推给单个用户的所有在线连接。
 * 不抛错——单连接发送失败不影响其它连接。
 */
export const publishToUser = (userId: number, event: DmEvent): void => {
  const bucket = connectionsByUser.get(userId);
  if (!bucket || bucket.size === 0) return;
  const payload = JSON.stringify(event);
  // 拷贝快照，避免回调里取消订阅时迭代失效
  const snapshot = Array.from(bucket);
  for (const ws of snapshot) {
    try {
      // ws.OPEN === 1
      if (ws.readyState === 1) ws.send(payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[dm-ws] send error', err);
    }
  }
};

/**
 * 把同一事件批量推给多个用户。
 *
 * 注意：本函数确保同一物理 ws 连接不会被同一事件发送两次（理论上不会发生，
 * 但为防御 API 误用而 dedupe）。
 */
export const publishToUsers = (userIds: number[], event: DmEvent): void => {
  if (userIds.length === 0) return;
  const payload = JSON.stringify(event);
  const sent = new Set<WebSocket>();
  for (const userId of userIds) {
    const bucket = connectionsByUser.get(userId);
    if (!bucket) continue;
    for (const ws of bucket) {
      if (sent.has(ws)) continue;
      sent.add(ws);
      try {
        if (ws.readyState === 1) ws.send(payload);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dm-ws] send error', err);
      }
    }
  }
};

/** 调试 / 监控用：返回某用户当前在线连接数。 */
export const connectionCount = (userId: number): number =>
  connectionsByUser.get(userId)?.size ?? 0;

/** 当前总在线连接数（所有用户）。 */
export const totalConnectionCount = (): number => {
  let total = 0;
  for (const bucket of connectionsByUser.values()) total += bucket.size;
  return total;
};
