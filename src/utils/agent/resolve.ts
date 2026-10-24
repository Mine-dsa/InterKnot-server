import type { Core } from '@strapi/strapi';
import { withSmallWebp, batchResolveEquippedAvatars } from '../common';

const CONFIG_CACHE_MS = 60_000;
let configCache: { at: number; value: any } | null = null;

export async function loadGlobalAgentConfig(strapi: Core.Strapi) {
  const now = Date.now();
  if (configCache && now - configCache.at < CONFIG_CACHE_MS) {
    return configCache.value;
  }
  const row = await strapi.db.query('api::ai-agent-config.ai-agent-config').findOne({
    populate: {},
  });
  const value = row || {
    globalEnabled: true,
    provider: 'openai',
    defaultModel: 'gpt-4o-mini',
    defaultTemperature: 0.7,
    defaultMaxTokens: 800,
    safetyAppend: '',
    dailyRepliesPerUser: 50,
    dailyTokenBudget: 500000,
  };
  configCache = { at: now, value };
  return value;
}

export function invalidateAgentConfigCache() {
  configCache = null;
}

const roleCardPopulate = {
  boundUser: {
    select: ['id', 'username', 'isAiAgent'],
    populate: {
      author: {
        select: ['id', 'documentId', 'name'],
        populate: { avatar: { select: ['url', 'width', 'height'] } },
      },
    },
  },
  avatar: { select: ['url', 'width', 'height'] },
};

export async function listEnabledRoleCards(strapi: Core.Strapi, opts?: { knockVisibleOnly?: boolean }) {
  const where: any = { enabled: true };
  if (opts?.knockVisibleOnly) where.knockVisible = true;

  const rows = await strapi.db.query('api::ai-role-card.ai-role-card').findMany({
    where,
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    populate: roleCardPopulate,
  });
  return rows || [];
}

/** 按 boundUser 查启用中的角色卡（避免每次 list 全表） */
export async function findRoleCardByBoundUserId(strapi: Core.Strapi, userId: number) {
  if (!Number.isInteger(userId)) return null;
  const rows = await strapi.db.query('api::ai-role-card.ai-role-card').findMany({
    where: { enabled: true, boundUser: { id: userId } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    limit: 1,
    populate: roleCardPopulate,
  });
  return rows?.[0] ?? null;
}

export async function collectAiAuthorDocumentIds(strapi: Core.Strapi): Promise<Set<string>> {
  const cards = await listEnabledRoleCards(strapi);
  const set = new Set<string>();
  for (const card of cards) {
    const docId = card?.boundUser?.author?.documentId;
    if (typeof docId === 'string' && docId) set.add(docId);
  }
  return set;
}

export function mergeEffectiveConfig(globalCfg: any, card: any) {
  const temp = card?.temperature ?? globalCfg?.defaultTemperature ?? 0.7;
  return {
    provider: globalCfg?.provider || 'openai',
    model: card?.model || globalCfg?.defaultModel || 'gpt-4o-mini',
    temperature: typeof temp === 'number' ? temp : Number(temp) || 0.7,
    maxTokens: globalCfg?.defaultMaxTokens ?? 800,
    systemPrompt: card?.systemPrompt || '',
    safetyAppend: globalCfg?.safetyAppend || '',
    globalEnabled: globalCfg?.globalEnabled !== false,
    dmEnabled: card?.dmEnabled !== false,
    commentEnabled: card?.commentEnabled !== false,
    // 角色 Tool Use（3.3.3）：该角色启用的工具名列表（如 ["search_posts"]）。
    tools: normalizeToolNames(card?.tools),
  };
}

/** 把角色卡 tools(json) 规范化为字符串数组；非法/空 → []。 */
export function normalizeToolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t): t is string => t.length > 0);
}

export function serializeRoleCardPublic(card: any, equippedMap?: Map<number, any>) {
  const user = card?.boundUser;
  const author = user?.author;
  const uid = user?.id;
  const avatarMedia = card?.avatar ? withSmallWebp(card.avatar) : null;
  const equipped =
    typeof uid === 'number' && equippedMap ? equippedMap.get(uid) : undefined;
  const equippedAvatar = equipped ? withSmallWebp(equipped) : null;
  const authorAvatar = author?.avatar ? withSmallWebp(author.avatar) : null;
  const resolvedUrl =
    avatarMedia?.url || equippedAvatar?.url || authorAvatar?.url || null;

  return {
    slug: card?.slug,
    displayName: card?.displayName,
    bio: card?.bio || null,
    avatar: resolvedUrl,
    sortOrder: card?.sortOrder ?? 0,
    boundUser: user
      ? {
          id: user.id,
          login: user.username,
          isAiAgent: user.isAiAgent === true,
          authorDocumentId: author?.documentId ?? null,
          name: author?.name || user.username,
          avatar: resolvedUrl,
        }
      : null,
  };
}

export async function serializeRoleCardsForPublic(strapi: Core.Strapi, cards: any[]) {
  const userIds = cards
    .map((c) => c?.boundUser?.id)
    .filter((id): id is number => Number.isInteger(id));
  const equippedMap = await batchResolveEquippedAvatars(strapi, userIds);
  return cards.map((c) => serializeRoleCardPublic(c, equippedMap));
}
