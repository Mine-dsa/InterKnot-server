import { config } from './config.js';
import { httpFetch } from './http.js';

const headers = () => ({
  'Content-Type': 'application/json',
  'X-Agent-Secret': config.agentSecret,
});

export async function agentFetch(path: string, init?: RequestInit) {
  const url = `${config.strapiUrl}/api${path}`;
  const res = await httpFetch(url, {
    ...init,
    label: 'strapi',
    headers: { ...headers(), ...(init?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

export async function getCommentContext(commentId: number) {
  return agentFetch(`/agent/context/comment/${commentId}`);
}

export async function getDmContext(messageId: number) {
  return agentFetch(`/agent/context/dm/${messageId}`);
}

export async function replyComment(commentId: number, aiUserId: number, body: string) {
  return agentFetch('/agent/internal/reply-comment', {
    method: 'POST',
    body: JSON.stringify({ commentId, aiUserId, body }),
  });
}

export async function replyDm(messageId: number, aiUserId: number, body: string) {
  return agentFetch('/agent/internal/reply-dm', {
    method: 'POST',
    body: JSON.stringify({ messageId, aiUserId, body }),
  });
}

export interface QuotaDecision {
  allowed: boolean;
  reason?: string;
}

/** 处理前用量预检；失败时 fail-open（放行）。 */
export async function checkQuota(userId: number): Promise<QuotaDecision> {
  if (!Number.isInteger(userId)) return { allowed: true };
  try {
    const json = (await agentFetch('/agent/internal/quota-check', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    })) as { data?: QuotaDecision };
    return json?.data ?? { allowed: true };
  } catch (err) {
    console.warn('[agent-worker] quota check failed (fail-open)', err);
    return { allowed: true };
  }
}

export interface JobLogPayload {
  jobType: 'comment' | 'dm';
  status: 'completed' | 'failed' | 'skipped';
  triggerId: number | string;
  aiUserId?: number;
  quotaUserId?: number;
  promptTokens?: number;
  completionTokens?: number;
  errorMessage?: string;
}

/** 审计落地：写入 ai-agent-job 并累加 token 用量。失败仅告警，不影响主流程。 */
export async function logJobResult(payload: JobLogPayload): Promise<void> {
  try {
    await agentFetch('/agent/internal/job-log', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[agent-worker] logJobResult failed', err);
  }
}

export interface DmStreamStart {
  /** 占位消息 documentId */
  documentId: string;
  /** 占位消息数值 id */
  id: number;
}

/** 流式回复（3.2.3）：创建空占位 AI 消息并广播 message.created。 */
export async function startDmStream(
  messageId: number,
  aiUserId: number,
): Promise<DmStreamStart> {
  const json = (await agentFetch('/agent/internal/dm-stream-start', {
    method: 'POST',
    body: JSON.stringify({ messageId, aiUserId }),
  })) as { data?: DmStreamStart };
  if (!json?.data?.documentId) throw new Error('dm-stream-start: no documentId');
  return json.data;
}

/** 流式回复：推送累计文本增量，前端实时渲染。失败仅告警。 */
export async function pushDmStreamDelta(
  placeholderDocumentId: string,
  acc: string,
): Promise<void> {
  try {
    await agentFetch('/agent/internal/dm-stream-delta', {
      method: 'POST',
      body: JSON.stringify({ documentId: placeholderDocumentId, content: acc }),
    });
  } catch (err) {
    console.warn('[agent-worker] pushDmStreamDelta failed', err);
  }
}

/** 流式回复：用最终（清洗后）文本定稿占位消息并广播 message.edited。 */
export async function finishDmStream(
  placeholderDocumentId: string,
  body: string,
): Promise<void> {
  await agentFetch('/agent/internal/dm-stream-finish', {
    method: 'POST',
    body: JSON.stringify({ documentId: placeholderDocumentId, body }),
  });
}



/** 角色 Tool Use（3.3.3）：把单个 tool_call 转发给 Strapi 执行，返回纯文本结果。 */
export async function runAgentTool(name: string, args: unknown): Promise<string> {
  try {
    const json = (await agentFetch('/agent/internal/tool', {
      method: 'POST',
      body: JSON.stringify({ name, arguments: args }),
    })) as { data?: { result?: string } };
    return String(json?.data?.result || '');
  } catch (err) {
    console.warn('[agent-worker] runAgentTool failed', name, err);
    return `工具执行失败：${name}`;
  }
}

export async function pulseDmTyping(messageId: number, aiUserId: number) {
  return agentFetch('/agent/internal/dm-typing', {
    method: 'POST',
    body: JSON.stringify({ messageId, aiUserId }),
  });
}

/** LLM 生成期间周期性推送「正在输入」，返回 stop 函数 */
export function startDmTypingPulse(messageId: number, aiUserId: number): () => void {
  const tick = () => {
    pulseDmTyping(messageId, aiUserId).catch(() => {});
  };
  tick();
  const interval = setInterval(tick, 2000);
  return () => clearInterval(interval);
}
