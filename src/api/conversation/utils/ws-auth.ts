/**
 * WS 握手鉴权：ticket 模式。
 *
 * 浏览器 WebSocket 不能传自定义 header，URL 里直接放 JWT 又会被代理 / 浏览器
 * 历史记录 / 服务器日志泄漏。所以走两段：
 *   1) 客户端携带 JWT 调 `POST /api/dm/socket/ticket` 拿到一次性短 ticket
 *   2) WS 连接 `wss://.../dm/socket?ticket=<ticket>`；服务端用 GETDEL 一次性消费
 *
 * 30 秒 TTL：足够浏览器拿到 ticket 后立刻打开 WS；超时则视为失效。
 * Redis 不可用时 issueTicket / verifyTicket 返回 null，调用方应降级（拒绝连接）。
 */
import crypto from 'crypto';
import { getRedis } from '../../../utils/redis';

const TICKET_PREFIX = 'dm:ws:ticket:';
const TICKET_TTL_SEC = 30;
const TICKET_BYTES = 24; // base64url 后约 32 字符

const ticketKey = (ticket: string) => `${TICKET_PREFIX}${ticket}`;

/**
 * 给 userId 签发一张 30s 一次性 ticket。
 * 失败（如 Redis 不可用）时返回 null，调用方应回 503。
 */
export const issueTicket = async (userId: number): Promise<string | null> => {
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

/**
 * 一次性消费 ticket，返回对应 userId 或 null。
 *
 * 用 Redis GETDEL（Redis 6.2+）保证原子取出 + 删除——同一 ticket 不能被两个
 * WS 连接共享。如果 Redis 版本过低降级 GET + DEL（有竞态但风险可控，本函数
 * 自动兼容）。
 */
export const verifyTicket = async (ticket: string): Promise<number | null> => {
  if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 128) {
    return null;
  }
  // 进一步限制字符集（只允许 base64url 字符），防恶意 key 注入。
  if (!/^[A-Za-z0-9_-]+$/.test(ticket)) return null;

  try {
    const redis = getRedis();
    const key = ticketKey(ticket);
    let raw: string | null = null;
    if (typeof (redis).getdel === 'function') {
      raw = await (redis).getdel(key);
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
