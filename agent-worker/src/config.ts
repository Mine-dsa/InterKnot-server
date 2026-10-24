import 'dotenv/config';

function envMs(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 本地 Strapi 建议 127.0.0.1，避免 Windows 上 localhost 解析到 ::1 */
const defaultStrapiUrl = 'http://127.0.0.1:1337';

export const config = {
  strapiUrl: (process.env.STRAPI_URL || defaultStrapiUrl).replace(/\/$/, ''),
  agentSecret: process.env.AGENT_INTERNAL_SECRET || '',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  llmModel: process.env.LLM_MODEL || '',
  queueKey: 'ik:agent:jobs',
  deadLetterKey: 'ik:agent:dead-letter',
  maxAttempts: envMs('AGENT_MAX_ATTEMPTS', 3),
  retryBackoffMs: envMs('AGENT_RETRY_BACKOFF_MS', 2_000),
  fetchTimeoutMs: envMs('AGENT_FETCH_TIMEOUT_MS', 60_000),
  /** DM 流式回复（3.2.3）开关，默认关闭；置 1/true 时启用占位消息+增量推送 */
  dmStreaming: /^(1|true|yes)$/i.test(process.env.AGENT_DM_STREAMING || ''),
  /** 流式增量推送节流：累计至少这么多字符才推一次，降低 WS / HTTP 频率 */
  streamMinChars: envMs('AGENT_STREAM_MIN_CHARS', 24),
};
