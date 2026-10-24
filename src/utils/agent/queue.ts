import type { Core } from '@strapi/strapi';
import { getRedis } from '../redis';

export const AGENT_QUEUE_KEY = 'ik:agent:jobs';
/** 失败任务超过最大重试次数后落入的死信队列 */
export const AGENT_DEAD_LETTER_KEY = 'ik:agent:dead-letter';

export type AgentJobPayload =
  | { type: 'comment'; commentId: number }
  | { type: 'dm'; messageId: number };

const jobDedupeKey = (payload: AgentJobPayload): string => {
  switch (payload.type) {
    case 'dm':
      return `ik:agent:dedupe:dm:${payload.messageId}`;
    case 'comment':
      return `ik:agent:dedupe:comment:${payload.commentId}`;
  }
};

export async function enqueueAgentJob(strapi: Core.Strapi, payload: AgentJobPayload): Promise<void> {
  try {
    const redis = getRedis();
    const dedupe = jobDedupeKey(payload);
    const locked = await redis.set(dedupe, '1', 'EX', 300, 'NX');
    if (locked !== 'OK') return;

    await redis.lpush(AGENT_QUEUE_KEY, JSON.stringify({ ...payload, attempt: 0, enqueuedAt: Date.now() }));
  } catch (err) {
    strapi?.log?.warn?.('[agent] enqueue failed', err);
  }
}
