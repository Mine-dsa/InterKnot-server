import { Redis } from 'ioredis';
import { config } from './config.js';
import { callLlm, callLlmChat, callLlmStream, type LlmMessage } from './llm.js';
import { resolveToolSpecs } from './tools.js';
import { guardImmersionReply } from './immersion-guard.js';
import { sanitizeCommunityReply } from './sanitize-reply.js';
import {
  buildCommentUserPrompt,
  buildDmUserPrompt,
  buildSystemPrompt,
  hasRoleSystemPrompt,
} from './prompt.js';
import { safeFetchTarget } from './http.js';
import {
  checkQuota,
  finishDmStream,
  getCommentContext,
  getDmContext,
  logJobResult,
  pushDmStreamDelta,
  replyComment,
  replyDm,
  runAgentTool,
  startDmStream,
  startDmTypingPulse,
} from './strapi.js';

const MAX_TOOL_ROUNDS = 3;

type JobType = 'comment' | 'dm';

type Job =
  | { type: 'comment'; commentId: number; attempt?: number }
  | { type: 'dm'; messageId: number; attempt?: number };

interface ReplyResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

interface JobOutcome {
  jobType: JobType;
  triggerId: number;
  status: 'completed' | 'skipped';
  aiUserId?: number;
  quotaUserId?: number;
  promptTokens?: number;
  completionTokens?: number;
  reason?: string;
}

const jobTriggerId = (job: Job): number => {
  switch (job.type) {
    case 'dm':
      return job.messageId;
    case 'comment':
      return job.commentId;
  }
};

/** 把 LLM 原始输出清洗 + 沉浸守卫 + 截断为最终可入库文本。 */
function processReplyBody(rawBody: string, maxLen: number, postContext?: string): string {
  const body = sanitizeCommunityReply(rawBody, { maxLength: maxLen });
  if (body) return finalizeReply(body, maxLen, postContext);

  const fallback = String(rawBody || '')
    .replace(/\[(?:reference|citation|ref|source)[:\s]*\d+\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!fallback) throw new Error('empty reply after sanitize');
  return finalizeReply(fallback, maxLen, postContext);
}

async function runLlmReply(
  effective: any,
  userPrompt: string,
  maxLen: number,
  postContext?: string,
): Promise<ReplyResult> {
  const llm = await callLlm({
    systemPrompt: buildSystemPrompt(effective),
    userPrompt,
    model: effective.model,
    temperature: effective.temperature ?? 0.7,
    maxTokens: effective.maxTokens ?? 800,
  });

  return {
    text: processReplyBody(llm.body, maxLen, postContext),
    promptTokens: llm.promptTokens,
    completionTokens: llm.completionTokens,
  };
}

/**
 * 角色 Tool Use（3.3.3）：带 function-calling 的多轮回复。
 * LLM 返回 tool_calls → worker 转发 Strapi 执行 → 结果回填 → 再次调用，
 * 直到模型给出最终文本或达到 MAX_TOOL_ROUNDS。与流式互斥（配置了 tools 时走此路径）。
 */
async function runToolLoopReply(
  effective: any,
  systemPrompt: string,
  userPrompt: string,
  maxLen: number,
  postContext: string | undefined,
  toolSpecs: ReturnType<typeof resolveToolSpecs>,
): Promise<ReplyResult> {
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  let promptTokens = 0;
  let completionTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // 最后一轮不再提供 tools，强制模型给出最终回答。
    const tools = round < MAX_TOOL_ROUNDS - 1 ? toolSpecs : [];
    const res = await callLlmChat({
      messages,
      model: effective.model,
      temperature: effective.temperature ?? 0.7,
      maxTokens: effective.maxTokens ?? 800,
      tools,
    });
    promptTokens += res.promptTokens ?? 0;
    completionTokens += res.completionTokens ?? 0;

    if (res.toolCalls.length === 0) {
      const text = processReplyBody(res.content, maxLen, postContext);
      return { text, promptTokens, completionTokens };
    }

    messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls });
    for (const call of res.toolCalls) {
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      const result = await runAgentTool(call.function.name, args);
      messages.push({ role: 'tool', content: result, tool_call_id: call.id });
    }
  }

  // 达到轮数上限仍未收敛：用现有上下文做一次无工具收尾。
  const last = await callLlmChat({
    messages,
    model: effective.model,
    temperature: effective.temperature ?? 0.7,
    maxTokens: effective.maxTokens ?? 800,
  });
  promptTokens += last.promptTokens ?? 0;
  completionTokens += last.completionTokens ?? 0;
  return {
    text: processReplyBody(last.content, maxLen, postContext),
    promptTokens,
    completionTokens,
  };
}

/**
 * 流式 DM 回复（3.2.3）：先建占位消息，边生成边推送累计文本增量，
 * 生成完成后用清洗后的最终文本定稿占位消息。
 */
async function runDmStreamReply(
  effective: any,
  userPrompt: string,
  maxLen: number,
  postContext: string | undefined,
  triggerMessageId: number,
  aiUserId: number,
): Promise<ReplyResult> {
  const placeholder = await startDmStream(triggerMessageId, aiUserId);
  let lastPushedLen = 0;
  const llm = await callLlmStream(
    {
      systemPrompt: buildSystemPrompt(effective),
      userPrompt,
      model: effective.model,
      temperature: effective.temperature ?? 0.7,
      maxTokens: effective.maxTokens ?? 800,
    },
    (acc) => {
      if (acc.length - lastPushedLen >= config.streamMinChars) {
        lastPushedLen = acc.length;
        void pushDmStreamDelta(placeholder.documentId, acc);
      }
    },
  );

  const text = processReplyBody(llm.body, maxLen, postContext);
  await finishDmStream(placeholder.documentId, text);
  return { text, promptTokens: llm.promptTokens, completionTokens: llm.completionTokens };
}

function finalizeReply(body: string, maxLen?: number, postContext?: string): string {
  let out = body;
  if (maxLen && out.length > maxLen) {
    out = `${out.slice(0, maxLen - 1)}…`;
  }
  const guarded = guardImmersionReply(out, { postContext });
  if (guarded.rewritten) {
    console.warn('[agent-worker] immersion guard: reply rewritten', guarded.reason || '');
  }
  return guarded.text;
}

async function processJob(job: Job): Promise<JobOutcome> {
  if (job.type === 'comment') {
    const payload = await getCommentContext(job.commentId);
    const data = payload?.data;
    if (!data?.aiUserId) {
      return { jobType: 'comment', triggerId: job.commentId, status: 'skipped', reason: 'no_agent_target' };
    }

    const quotaUserId = data.quotaUserId;
    const quota = await checkQuota(quotaUserId);
    if (!quota.allowed) {
      return {
        jobType: 'comment',
        triggerId: job.commentId,
        status: 'skipped',
        aiUserId: data.aiUserId,
        quotaUserId,
        reason: quota.reason || 'quota_blocked',
      };
    }

    const effective = data.effective || {};
    if (!hasRoleSystemPrompt(effective)) {
      console.warn('[agent-worker] ai-role-card systemPrompt is empty for aiUserId=', data.aiUserId);
    }
    const ctx = data?.context || {};
    const postContext = [ctx.articleTitle, ctx.articleBody].filter(Boolean).join('\n');
    const commentUserPrompt = buildCommentUserPrompt(data, effective);
    const toolSpecs = resolveToolSpecs(effective.tools);
    let reply: ReplyResult;
    if (toolSpecs.length > 0) {
      reply = await runToolLoopReply(
        effective,
        buildSystemPrompt(effective),
        commentUserPrompt,
        1500,
        postContext,
        toolSpecs,
      );
    } else {
      reply = await runLlmReply(effective, commentUserPrompt, 1500, postContext);
    }
    await replyComment(job.commentId, data.aiUserId, reply.text);
    return {
      jobType: 'comment',
      triggerId: job.commentId,
      status: 'completed',
      aiUserId: data.aiUserId,
      quotaUserId,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
    };
  }

  const payload = await getDmContext(job.messageId);
  const data = payload?.data;
  if (!data?.aiUserId) {
    return { jobType: 'dm', triggerId: job.messageId, status: 'skipped', reason: 'no_agent_target' };
  }

  const quotaUserId = data.quotaUserId;
  const quota = await checkQuota(quotaUserId);
  if (!quota.allowed) {
    return {
      jobType: 'dm',
      triggerId: job.messageId,
      status: 'skipped',
      aiUserId: data.aiUserId,
      quotaUserId,
      reason: quota.reason || 'quota_blocked',
    };
  }

  const effective = data.effective || {};
  if (!hasRoleSystemPrompt(effective)) {
    console.warn('[agent-worker] ai-role-card systemPrompt is empty for aiUserId=', data.aiUserId);
  }
  const stopTyping = startDmTypingPulse(job.messageId, data.aiUserId);
  try {
    const dmCtx = data?.context || {};
    const dmPostContext = [dmCtx.recentMessages, dmCtx.latestUserMessage]
      .filter(Boolean)
      .join('\n');
    const dmUserPrompt = buildDmUserPrompt(data, effective);
    const toolSpecs = resolveToolSpecs(effective.tools);
    let reply: ReplyResult;
    if (toolSpecs.length > 0) {
      // 角色 Tool Use（3.3.3）：配置了工具的角色走多轮 function-calling，与流式互斥。
      reply = await runToolLoopReply(
        effective,
        buildSystemPrompt(effective),
        dmUserPrompt,
        2500,
        dmPostContext,
        toolSpecs,
      );
      await replyDm(job.messageId, data.aiUserId, reply.text);
    } else if (config.dmStreaming) {
      // 流式：占位消息 + 增量推送已在 runDmStreamReply 内完成定稿，无需再 replyDm
      reply = await runDmStreamReply(
        effective,
        dmUserPrompt,
        2500,
        dmPostContext,
        job.messageId,
        data.aiUserId,
      );
    } else {
      reply = await runLlmReply(effective, dmUserPrompt, 2500, dmPostContext);
      await replyDm(job.messageId, data.aiUserId, reply.text);
    }
    return {
      jobType: 'dm',
      triggerId: job.messageId,
      status: 'completed',
      aiUserId: data.aiUserId,
      quotaUserId,
      promptTokens: reply.promptTokens,
      completionTokens: reply.completionTokens,
    };
  } finally {
    stopTyping();
  }
}

/** 任务失败：未达上限则退避后重新入队，否则落入死信队列并写审计。 */
async function handleJobFailure(redis: Redis, job: Job, err: unknown): Promise<void> {
  const attempt = Number.isInteger(job.attempt) ? (job.attempt as number) : 0;
  const nextAttempt = attempt + 1;
  const errMsg = err instanceof Error ? err.message : String(err);
  const triggerId = jobTriggerId(job);
  console.error('[agent-worker] job failed', { triggerId, type: job.type, attempt, err: errMsg });

  if (nextAttempt < config.maxAttempts) {
    await new Promise((r) => setTimeout(r, config.retryBackoffMs));
    await redis.lpush(
      config.queueKey,
      JSON.stringify({ ...job, attempt: nextAttempt, enqueuedAt: Date.now() }),
    );
    console.warn('[agent-worker] re-enqueued', { triggerId, nextAttempt });
    return;
  }

  await redis.lpush(
    config.deadLetterKey,
    JSON.stringify({ job, attempts: nextAttempt, error: errMsg, failedAt: Date.now() }),
  );
  await logJobResult({
    jobType: job.type,
    status: 'failed',
    triggerId,
    errorMessage: errMsg,
  });
  console.error('[agent-worker] moved to dead-letter', { triggerId, attempts: nextAttempt });
}

export async function runWorkerLoop() {
  if (!config.agentSecret) {
    console.error('[agent-worker] AGENT_INTERNAL_SECRET is required');
    process.exit(1);
  }

  const redis = new Redis(config.redisUrl);
  console.log('[agent-worker] listening on', config.queueKey);
  console.log('[agent-worker] strapi →', safeFetchTarget(`${config.strapiUrl}/api`));
  console.log('[agent-worker] llm    →', safeFetchTarget(`${config.llmBaseUrl}/chat/completions`));

  while (true) {
    let job: Job | null = null;
    try {
      const raw = await redis.brpop(config.queueKey, 0);
      if (!raw || !raw[1]) continue;
      const parsed = JSON.parse(raw[1]) as Record<string, any>;
      if (parsed.type === 'summary' || parsed.type === 'moderation') {
        console.log('[agent-worker] skipping removed job type:', parsed.type);
        continue;
      }
      switch (parsed.type) {
        case 'dm':
          job = { type: 'dm', messageId: parsed.messageId, attempt: parsed.attempt };
          break;
        default:
          job = { type: 'comment', commentId: parsed.commentId, attempt: parsed.attempt };
      }

      console.log('[agent-worker] job', job);
      const outcome = await processJob(job);
      await logJobResult({
        jobType: outcome.jobType,
        status: outcome.status,
        triggerId: outcome.triggerId,
        aiUserId: outcome.aiUserId,
        quotaUserId: outcome.quotaUserId,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        errorMessage: outcome.reason,
      });
      console.log('[agent-worker] done', { ...job, status: outcome.status });
    } catch (err) {
      if (job) {
        await handleJobFailure(redis, job, err).catch((e) =>
          console.error('[agent-worker] handleJobFailure error', e),
        );
      } else {
        console.error('[agent-worker] error', err);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}
