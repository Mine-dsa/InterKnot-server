/**
 * 进程内 SSE 总线：每个 recipient userId 维护一组订阅者。
 *
 * 设计取舍：
 * - 单进程实现，无需额外依赖；多实例部署时（PM2 cluster / k8s 多副本）需要换 Redis pub/sub
 *   或 sticky session。短期单实例足够。
 * - 订阅者用回调函数表达，避免对 EventEmitter 的引用泄漏。
 */

export type KnockSseEventType =
  | 'notification.created'
  | 'notification.read'
  | 'notification.read.bulk';

export interface KnockSseEvent {
  type: KnockSseEventType;
  /** 受影响的会话 id（用于前端 invalidation） */
  conversationId?: string;
  /** notification documentId（created/read 单条时有） */
  notificationId?: string;
  /** 批量已读时的影响数 */
  count?: number;
  /** 服务端时间戳 ISO 字符串 */
  at: string;
}

type Subscriber = (event: KnockSseEvent) => void;

const subscribersByUser = new Map<number, Set<Subscriber>>();

/**
 * 单用户同时订阅数上限。超过时按 FIFO 淘汰最老的连接。
 * 防止恶意 client 反复 `new EventSource(...)` 累积 socket / 内存。
 *
 * 同一用户多端登录场景：5 个连接（PC+手机+平板+保留余量）够用。
 */
const SUBSCRIBER_LIMIT_PER_USER = 5;

/**
 * 当订阅者被「踢出」时调用的回调，允许 stream controller 主动关闭旧连接。
 * 在 subscribe 返回的 unsubscribe 之前，会先调用对应的 evict callback。
 */
type EvictCallback = () => void;
const evictCallbacks = new WeakMap<Subscriber, EvictCallback>();

export const subscribe = (
  userId: number,
  fn: Subscriber,
  onEvict?: EvictCallback,
): (() => void) => {
  let bucket = subscribersByUser.get(userId);
  if (!bucket) {
    bucket = new Set();
    subscribersByUser.set(userId, bucket);
  }

  // 超出上限，淘汰最老的（Set 迭代顺序 = 插入顺序）
  while (bucket.size >= SUBSCRIBER_LIMIT_PER_USER) {
    const oldest = bucket.values().next().value as Subscriber | undefined;
    if (!oldest) break;
    bucket.delete(oldest);
    const evict = evictCallbacks.get(oldest);
    evictCallbacks.delete(oldest);
    if (evict) {
      try {
        evict();
      } catch {
        /* noop */
      }
    }
  }

  bucket.add(fn);
  if (onEvict) evictCallbacks.set(fn, onEvict);

  return () => {
    const b = subscribersByUser.get(userId);
    if (!b) return;
    b.delete(fn);
    evictCallbacks.delete(fn);
    if (b.size === 0) subscribersByUser.delete(userId);
  };
};

export const publish = (userId: number, event: KnockSseEvent): void => {
  const bucket = subscribersByUser.get(userId);
  if (!bucket || bucket.size === 0) return;
  // 拷贝快照避免回调里取消订阅时的迭代失效
  const snapshot = Array.from(bucket);
  for (const fn of snapshot) {
    try {
      fn(event);
    } catch (err) {
      // 单个订阅者异常不影响其它订阅者
      // eslint-disable-next-line no-console
      console.error('[knock-sse] subscriber error', err);
    }
  }
};

export const subscriberCount = (userId: number): number =>
  subscribersByUser.get(userId)?.size ?? 0;
