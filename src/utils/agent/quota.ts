import type { Core } from '@strapi/strapi';
import { getRedis } from '../redis';

/**
 * Agent 用量限流：基于 Redis 的每用户每日计数器。
 * - 回复条数：调用 LLM 前预占（INCR 当日计数）；
 * - token 预算：LLM 调用完成后累加（事后扣减），超额后拒绝下一条。
 *
 * 所有操作在 Redis 异常时「fail-open」（放行），避免 Redis 抖动导致 AI 整体不可用。
 */

const SECONDS_PER_DAY = 86_400;

/** UTC 日期戳 YYYYMMDD */
function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const replyCountKey = (userId: number, day = dayKey()) =>
  `ik:agent:quota:replies:${userId}:${day}`;
const tokenUsageKey = (userId: number, day = dayKey()) =>
  `ik:agent:quota:tokens:${userId}:${day}`;

export interface QuotaLimits {
  dailyRepliesPerUser?: number;
  dailyTokenBudget?: number;
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
}

function isPositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * 预占一次回复额度并校验当日 token 预算。
 * - token 预算超出 → 直接拒绝（不消耗回复计数）；
 * - 回复条数：INCR 当日计数，超过上限则拒绝（计数保持递增，使后续同样被拒）。
 */
export async function checkQuota(
  strapi: Core.Strapi,
  userId: number,
  limits: QuotaLimits,
): Promise<QuotaDecision> {
  if (!Number.isInteger(userId)) return { allowed: true };
  try {
    const redis = getRedis();

    if (isPositive(limits.dailyTokenBudget)) {
      const used = Number(await redis.get(tokenUsageKey(userId))) || 0;
      if (used >= limits.dailyTokenBudget) {
        return { allowed: false, reason: 'daily_token_budget_exceeded' };
      }
    }

    if (isPositive(limits.dailyRepliesPerUser)) {
      const key = replyCountKey(userId);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, SECONDS_PER_DAY);
      if (count > limits.dailyRepliesPerUser) {
        return { allowed: false, reason: 'daily_reply_limit_exceeded' };
      }
    }

    return { allowed: true };
  } catch (err) {
    strapi?.log?.warn?.('[agent] quota check failed (fail-open)', err);
    return { allowed: true };
  }
}

/** 累加当日 token 用量（事后扣减）。 */
export async function addTokenUsage(
  strapi: Core.Strapi,
  userId: number,
  tokens: number,
): Promise<void> {
  if (!Number.isInteger(userId) || !isPositive(tokens)) return;
  try {
    const redis = getRedis();
    const key = tokenUsageKey(userId);
    const total = await redis.incrby(key, Math.round(tokens));
    if (total === Math.round(tokens)) await redis.expire(key, SECONDS_PER_DAY);
  } catch (err) {
    strapi?.log?.warn?.('[agent] addTokenUsage failed', err);
  }
}
