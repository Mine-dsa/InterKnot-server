import type { Context } from 'koa';
import { getErrorMessage } from '../../../utils/common';
import {
  buildCommentLlmContext,
  buildDmLlmContext,
  executeCommentReply,
  executeDmReply,
} from '../../../utils/agent/execute';
import {
  findRoleCardByBoundUserId,
  loadGlobalAgentConfig,
  listEnabledRoleCards,
  mergeEffectiveConfig,
  serializeRoleCardPublic,
  serializeRoleCardsForPublic,
} from '../../../utils/agent/resolve';
import { resolveCommentAgentTargetUserId } from '../../../utils/agent/triggers';
import { resolveDmAgentTargetUserId } from '../../../utils/agent/execute';
import {
  finishDmStreamMessage,
  pushDmStreamDelta,
  startDmStreamMessage,
} from '../../../utils/agent/dm-stream';
import { publishDmTyping } from '../../conversation/utils/dm-typing';
import { addTokenUsage, checkQuota } from '../../../utils/agent/quota';
import { getRedis } from '../../../utils/redis';
import { AGENT_DEAD_LETTER_KEY } from '../../../utils/agent/queue';

import { executeAgentTool, isAllowedTool } from '../../../utils/agent/tools';

const JOB_TYPES = ['comment', 'dm'] as const;
const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'skipped'] as const;
type JobType = (typeof JOB_TYPES)[number];
type JobStatus = (typeof JOB_STATUSES)[number];

export default {
  async characters(ctx: Context) {
    const cards = await listEnabledRoleCards(strapi, { knockVisibleOnly: true });
    ctx.send({
      data: await serializeRoleCardsForPublic(strapi, cards),
    });
  },

  async config(ctx: Context) {
    const globalCfg = await loadGlobalAgentConfig(strapi);
    ctx.send({
      data: {
        globalEnabled: globalCfg?.globalEnabled !== false,
        provider: globalCfg?.provider || 'openai',
        defaultModel: globalCfg?.defaultModel || 'gpt-4o-mini',
        defaultTemperature: globalCfg?.defaultTemperature ?? 0.7,
        defaultMaxTokens: globalCfg?.defaultMaxTokens ?? 800,
        dailyRepliesPerUser: globalCfg?.dailyRepliesPerUser ?? 50,
        dailyTokenBudget: globalCfg?.dailyTokenBudget ?? 500000,
      },
    });
  },

  async resolve(ctx: Context) {
    const userId = Number(ctx.query?.userId);
    if (!Number.isInteger(userId)) return ctx.badRequest('userId required');

    const card = await findRoleCardByBoundUserId(strapi, userId);
    if (!card) return ctx.notFound();

    const globalCfg = await loadGlobalAgentConfig(strapi);
    const [roleCard] = await serializeRoleCardsForPublic(strapi, [card]);
    ctx.send({
      data: {
        roleCard,
        effective: mergeEffectiveConfig(globalCfg, card),
      },
    });
  },

  async contextComment(ctx: Context) {
    const commentId = Number(ctx.params?.id);
    if (!Number.isInteger(commentId)) return ctx.badRequest('invalid id');

    const aiUserId = await resolveCommentAgentTargetUserId(strapi, commentId);
    if (!aiUserId) return ctx.notFound('no agent for this comment');

    const card = await findRoleCardByBoundUserId(strapi, aiUserId);
    if (!card) return ctx.notFound();

    const globalCfg = await loadGlobalAgentConfig(strapi);
    const built = await buildCommentLlmContext(strapi, commentId);
    const { quotaUserId = null, ...context } = built || {};

    ctx.send({
      data: {
        aiUserId,
        quotaUserId,
        roleCardSlug: card.slug,
        effective: mergeEffectiveConfig(globalCfg, card),
        context,
      },
    });
  },

  async contextDm(ctx: Context) {
    const messageId = Number(ctx.params?.id);
    if (!Number.isInteger(messageId)) return ctx.badRequest('invalid id');

    const aiUserId = await resolveDmAgentTargetUserId(strapi, messageId);
    if (!aiUserId) return ctx.notFound('no agent for this message');

    const card = await findRoleCardByBoundUserId(strapi, aiUserId);
    if (!card) return ctx.notFound();

    const globalCfg = await loadGlobalAgentConfig(strapi);
    const built = await buildDmLlmContext(strapi, messageId);
    const { quotaUserId = null, ...context } = built || {};

    ctx.send({
      data: {
        aiUserId,
        quotaUserId,
        roleCardSlug: card.slug,
        effective: mergeEffectiveConfig(globalCfg, card),
        context,
      },
    });
  },

  async replyComment(ctx: Context) {
    const commentId = Number(ctx.request?.body?.commentId);
    const body = typeof ctx.request?.body?.body === 'string' ? ctx.request.body.body : '';
    const aiUserId = Number(ctx.request?.body?.aiUserId);

    if (!Number.isInteger(commentId) || !Number.isInteger(aiUserId)) {
      return ctx.badRequest('commentId and aiUserId required');
    }
    if (!body.trim()) return ctx.badRequest('body required');

    try {
      const result = await executeCommentReply(strapi, {
        triggerCommentId: commentId,
        body: body.trim(),
        aiUserId,
      });
      ctx.send({ data: result });
    } catch (err: unknown) {
      strapi.log.warn('[agent] replyComment failed', err);
      return ctx.badRequest(getErrorMessage(err) || 'reply failed');
    }
  },

  async dmTyping(ctx: Context) {
    const messageId = Number(ctx.request?.body?.messageId);
    let aiUserId = Number(ctx.request?.body?.aiUserId);

    if (!Number.isInteger(messageId)) return ctx.badRequest('messageId required');

    const resolvedAiUserId = await resolveDmAgentTargetUserId(strapi, messageId);
    if (!Number.isInteger(resolvedAiUserId)) return ctx.notFound('no agent for this message');

    if (!Number.isInteger(aiUserId)) {
      aiUserId = resolvedAiUserId;
    } else if (aiUserId !== resolvedAiUserId) {
      return ctx.forbidden('aiUserId mismatch');
    }

    const msg: any = await strapi.db.query('api::message.message').findOne({
      where: { id: messageId },
      select: ['id'],
      populate: { conversation: { select: ['documentId'] } },
    });
    const convDocId = msg?.conversation?.documentId;
    if (typeof convDocId !== 'string' || !convDocId) {
      return ctx.badRequest('conversation not found');
    }

    await publishDmTyping(strapi, convDocId, aiUserId);
    ctx.send({ data: { ok: true } });
  },

  async replyDm(ctx: Context) {
    const messageId = Number(ctx.request?.body?.messageId);
    const body = typeof ctx.request?.body?.body === 'string' ? ctx.request.body.body : '';
    const aiUserId = Number(ctx.request?.body?.aiUserId);

    if (!Number.isInteger(messageId) || !Number.isInteger(aiUserId)) {
      return ctx.badRequest('messageId and aiUserId required');
    }
    if (!body.trim()) return ctx.badRequest('body required');

    try {
      const result = await executeDmReply(strapi, {
        triggerMessageId: messageId,
        body: body.trim(),
        aiUserId,
      });
      ctx.send({ data: result });
    } catch (err: unknown) {
      strapi.log.warn('[agent] replyDm failed', err);
      return ctx.badRequest(getErrorMessage(err) || 'reply failed');
    }
  },

  /** 流式回复（3.2.3）：创建空占位 AI 消息。 */
  async dmStreamStart(ctx: Context) {
    const messageId = Number(ctx.request?.body?.messageId);
    const aiUserId = Number(ctx.request?.body?.aiUserId);
    if (!Number.isInteger(messageId) || !Number.isInteger(aiUserId)) {
      return ctx.badRequest('messageId and aiUserId required');
    }
    try {
      const result = await startDmStreamMessage(strapi, messageId, aiUserId);
      ctx.send({ data: result });
    } catch (err: unknown) {
      strapi.log.warn('[agent] dmStreamStart failed', err);
      return ctx.badRequest(getErrorMessage(err) || 'stream start failed');
    }
  },

  /** 流式回复：广播累计文本增量。 */
  async dmStreamDelta(ctx: Context) {
    const documentId = String(ctx.request?.body?.documentId || '');
    const content = typeof ctx.request?.body?.content === 'string' ? ctx.request.body.content : '';
    if (!documentId) return ctx.badRequest('documentId required');
    try {
      await pushDmStreamDelta(strapi, documentId, content);
      ctx.send({ data: { ok: true } });
    } catch (err: unknown) {
      strapi.log.warn('[agent] dmStreamDelta failed', err);
      return ctx.badRequest(getErrorMessage(err) || 'stream delta failed');
    }
  },

  /** 流式回复：用最终文本定稿占位消息。 */
  async dmStreamFinish(ctx: Context) {
    const documentId = String(ctx.request?.body?.documentId || '');
    const body = typeof ctx.request?.body?.body === 'string' ? ctx.request.body.body : '';
    if (!documentId) return ctx.badRequest('documentId required');
    if (!body.trim()) return ctx.badRequest('body required');
    try {
      const result = await finishDmStreamMessage(strapi, documentId, body.trim());
      ctx.send({ data: result });
    } catch (err: unknown) {
      strapi.log.warn('[agent] dmStreamFinish failed', err);
      return ctx.badRequest(getErrorMessage(err) || 'stream finish failed');
    }
  },

  /** 用量预检：预占一次回复额度并校验当日 token 预算。 */
  async quotaCheck(ctx: Context) {
    const userId = Number(ctx.request?.body?.userId);
    if (!Number.isInteger(userId)) return ctx.badRequest('userId required');

    const cfg = await loadGlobalAgentConfig(strapi);
    if (cfg?.globalEnabled === false) {
      return ctx.send({ data: { allowed: false, reason: 'global_disabled' } });
    }

    const decision = await checkQuota(strapi, userId, {
      dailyRepliesPerUser: cfg?.dailyRepliesPerUser,
      dailyTokenBudget: cfg?.dailyTokenBudget,
    });
    ctx.send({ data: decision });
  },

  /** 审计落地：worker 处理完成/失败后写入 ai-agent-job，并累加当日 token 用量。 */
  async logJob(ctx: Context) {
    const b = ctx.request?.body ?? {};
    const jobType = (JOB_TYPES as readonly string[]).includes(b.jobType)
      ? (b.jobType as JobType)
      : null;
    const status = (JOB_STATUSES as readonly string[]).includes(b.status)
      ? (b.status as JobStatus)
      : null;
    if (!jobType || !status) return ctx.badRequest('valid jobType and status required');

    const triggerId = b.triggerId != null ? String(b.triggerId) : null;
    const promptTokens = Number.isFinite(Number(b.promptTokens)) ? Number(b.promptTokens) : null;
    const completionTokens = Number.isFinite(Number(b.completionTokens))
      ? Number(b.completionTokens)
      : null;
    const errorMessage =
      typeof b.errorMessage === 'string' && b.errorMessage ? b.errorMessage.slice(0, 1000) : null;

    const aiUserId = Number(b.aiUserId);
    let roleCardId: number | null = null;
    if (Number.isInteger(aiUserId)) {
      const card = await findRoleCardByBoundUserId(strapi, aiUserId);
      roleCardId = card?.id ?? null;
    }

    try {
      await strapi.db.query('api::ai-agent-job.ai-agent-job').create({
        data: {
          jobType,
          status,
          triggerId,
          roleCard: roleCardId ?? undefined,
          errorMessage: errorMessage ?? undefined,
          promptTokens: promptTokens ?? undefined,
          completionTokens: completionTokens ?? undefined,
        },
      });
    } catch (err: unknown) {
      strapi.log.warn('[agent] logJob create failed', err);
    }

    const quotaUserId = Number(b.quotaUserId);
    const totalTokens = (promptTokens ?? 0) + (completionTokens ?? 0);
    if (Number.isInteger(quotaUserId) && totalTokens > 0) {
      await addTokenUsage(strapi, quotaUserId, totalTokens);
    }

    ctx.send({ data: { ok: true } });
  },



  /** 角色 Tool Use（3.3.3）：执行单个工具调用，返回纯文本结果。 */
  async executeTool(ctx: Context) {
    const name = String(ctx.request?.body?.name || '').trim();
    if (!name || !isAllowedTool(name)) return ctx.badRequest('unknown tool');
    let args: any = ctx.request?.body?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args || '{}');
      } catch {
        args = {};
      }
    }
    try {
      const result = await executeAgentTool(strapi, name, args);
      ctx.send({ data: { result: String(result || '').slice(0, 4000) } });
    } catch (err: unknown) {
      strapi.log.warn('[agent] executeTool failed', err);
      ctx.send({ data: { result: `工具执行失败：${name}` } });
    }
  },

  /** 死信队列查看（后台排查毒消息用）。 */
  async deadLetter(ctx: Context) {
    const limit = Math.min(Math.max(Number(ctx.query?.limit) || 50, 1), 200);
    try {
      const redis = getRedis();
      const raw = await redis.lrange(AGENT_DEAD_LETTER_KEY, 0, limit - 1);
      const items = raw.map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return { raw: s };
        }
      });
      ctx.send({ data: { count: items.length, items } });
    } catch (err: unknown) {
      strapi.log.warn('[agent] deadLetter read failed', err);
      ctx.send({ data: { count: 0, items: [] } });
    }
  },
};
