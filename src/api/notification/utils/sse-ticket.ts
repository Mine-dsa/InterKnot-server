/**
 * 敲敲 SSE（EventSource）握手鉴权：ticket 模式。
 *
 * 与 dm/ws-auth.ts 同范式：浏览器 EventSource 不能传自定义 header，URL 里直接
 * 放 JWT 会被代理 / 浏览器历史 / 服务器日志泄漏。两段式：
 *   1) 客户端携带 JWT 调 `POST /api/knock/stream-ticket` 拿一次性短 ticket
 *   2) EventSource 连接 `/api/knock/stream?ticket=<ticket>`；服务端 GETDEL 一次性消费
 *
 * 独立于 DM WS 的票据前缀（dm:ws:ticket:），互不通用（最小权限）。
 * Redis 不可用时签发/校验返回 null：与 DM WS 同语义（拒绝连接，前端靠轮询兜底）。
 * 注：无 REDIS_URL 的本地形态下 utils/redis 提供内存 mock，KV 语义真实可用。
 */
import crypto from 'crypto';
import { getRedis } from '../../../utils/redis';

const TICKET_PREFIX = 'knock:sse:ticket:';
const TICKET_TTL_SEC = 30;
const TICKET_BYTES = 24; // base64url 后约 32 字符

const ticketKey = (ticket: string) => `${TICKET_PREFIX}${ticket}`;

/** 给 userId 签发一张 30s 一次性 ticket。失败返回 null，调用方应回 503。 */
export const issueSseTicket = async (userId: number): Promise<string | null> => {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  try {
    const ticket = crypto.randomBytes(TICKET_BYTES).toString('base64url');
    const redis = getRedis();
    await redis.set(ticketKey(ticket), String(userId), 'EX', TICKET_TTL_SEC);
    return ticket;
  } catch {
    return null;
  }
};

/** 一次性消费 ticket，返回对应 userId 或 null（过期/复用/非法）。 */
export const verifySseTicket = async (ticket: string): Promise<number | null> => {
  if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 128) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(ticket)) {
    return null;
  }

  try {
    const redis = getRedis();
    const key = ticketKey(ticket);
    let raw: string | null = null;
    if (typeof (redis as any).getdel === 'function') {
      raw = await (redis as any).getdel(key);
    } else {
      raw = await redis.get(key);
      if (raw) await redis.del(key);
    }
    if (!raw) return null;
    const id = Number.parseInt(raw, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
};
