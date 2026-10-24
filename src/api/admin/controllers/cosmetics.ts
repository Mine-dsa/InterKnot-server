/**
 * cosmetics admin controller（/management/cosmetics/*）
 *
 * 称号/勋章管理中心：完整的可控制 / 可追溯 / 可复原。
 * - 可控制：CRUD + enabled 开关 + condition 自定义触发条件
 * - 可追溯：所有授予/撤销落 grant 记录（含操作者、时间、原因、来源 manual/auto）
 * - 可复原：撤销为软删除（保留历史），可再次授予生成新纪录
 */
import {
  CosmeticsKind,
  cosmeticUid,
  describeCondition,
  evaluateAndGrantAuto,
  grantCosmetic,
  normalizeCondition,
  revokeCosmetic,
  validateConditionPayload,
} from '../../../utils/cosmetics';
import { parsePagination } from '../../../utils/common';

const USER_UID = 'plugin::users-permissions.user';

const parseKind = (raw: unknown): CosmeticsKind | null => {
  const value = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (value === 'title' || value === 'titles') return 'title';
  if (value === 'medal' || value === 'medals') return 'medal';
  return null;
};

const relKeyOf = (kind: CosmeticsKind) => (kind === 'title' ? 'title' : 'medal');

/**
 * 卸下所有用户装备中的指定装扮。
 * 注意：Strapi 的 updateMany 不支持 relation 字段（processData 会剥离），
 * 这里直接操作 link 表（up_users_equipped_title_lnk / up_users_equipped_medal_lnk）。
 */
async function unequipCosmeticFromAll(strapi: any, kind: CosmeticsKind, cosmeticId: number) {
  const linkTable =
    kind === 'title' ? 'up_users_equipped_title_lnk' : 'up_users_equipped_medal_lnk';
  const linkColumn = kind === 'title' ? 'title_id' : 'medal_id';
  try {
    await strapi.db.connection(linkTable).where({ [linkColumn]: cosmeticId }).del();
  } catch (err) {
    strapi.log.warn(`[cosmetics] unequip-all failed for ${kind}#${cosmeticId}: ${err}`);
  }
}

const grantUidOf = (kind: CosmeticsKind) =>
  kind === 'title' ? 'api::title-grant.title-grant' : 'api::medal-grant.medal-grant';

/** 面向管理端序列化：带条件原文 + 描述 + 生效授予统计 */
const serializeCosmetic = (item: any, activeGrantCount: number, totalGrantCount: number) => {
  const condition = normalizeCondition(item?.condition);
  return {
    documentId: item?.documentId ?? null,
    name: item?.name ?? '',
    description: item?.description ?? null,
    image: item?.image ?? null,
    rarity: item?.rarity ?? 'common',
    enabled: item?.enabled !== false,
    condition: item?.condition ?? null,
    conditionDescription: describeCondition(condition),
    sortOrder: item?.sortOrder ?? 0,
    activeGrantCount,
    totalGrantCount,
    createdAt: item?.createdAt ?? null,
    updatedAt: item?.updatedAt ?? null,
  };
};

/** 支持 userId（内部 id）/ username / userDocumentId 三种定位方式 */
async function resolveTargetUser(strapi: any, body: Record<string, unknown>) {
  const userId = Number(body.userId);
  if (Number.isFinite(userId) && userId > 0) {
    return strapi.db.query(USER_UID).findOne({ where: { id: userId }, select: ['id', 'username'] });
  }
  if (typeof body.username === 'string' && body.username.trim()) {
    return strapi.db
      .query(USER_UID)
      .findOne({ where: { username: body.username.trim() }, select: ['id', 'username'] });
  }
  if (typeof body.userDocumentId === 'string' && body.userDocumentId.trim()) {
    return strapi.db
      .query(USER_UID)
      .findOne({ where: { documentId: body.userDocumentId.trim() }, select: ['id', 'username'] });
  }
  return null;
}

export default {
  /** GET /management/cosmetics/:kind —— 目录列表（含授予统计） */
  async listCosmetics(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');

    const relKey = relKeyOf(kind);

    const [cosmetics, allGrants] = await Promise.all([
      strapi.db.query(cosmeticUid(kind)).findMany({
        populate: { image: { select: ['url', 'width', 'height'] } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        limit: 1000,
      }),
      strapi.db.query(grantUidOf(kind)).findMany({
        select: ['id', 'revokedAt'],
        populate: { [relKey]: { select: ['id'] } },
        limit: 100000,
      }),
    ]);

    const activeByCosmetic = new Map<number, number>();
    const totalByCosmetic = new Map<number, number>();
    for (const grant of allGrants || []) {
      const cosmeticId = grant?.[relKey]?.id;
      if (typeof cosmeticId !== 'number') continue;
      totalByCosmetic.set(cosmeticId, (totalByCosmetic.get(cosmeticId) ?? 0) + 1);
      if (!grant.revokedAt) {
        activeByCosmetic.set(cosmeticId, (activeByCosmetic.get(cosmeticId) ?? 0) + 1);
      }
    }

    ctx.send({
      data: (cosmetics || []).map((item: any) =>
        serializeCosmetic(
          item,
          activeByCosmetic.get(item.id) ?? 0,
          totalByCosmetic.get(item.id) ?? 0,
        ),
      ),
    });
  },

  /** POST /management/cosmetics/:kind —— 创建 */
  async createCosmetic(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 32) return ctx.badRequest('name 必填且不超过 32 字符');

    const conditionCheck = validateConditionPayload(body.condition);
    if (conditionCheck.ok === false) return ctx.badRequest(conditionCheck.error);

    const imageId = Number(body.imageId);

    try {
      const created = await strapi.db.query(cosmeticUid(kind)).create({
        data: {
          name,
          description:
            typeof body.description === 'string' ? body.description.substring(0, 200) : null,
          image: Number.isFinite(imageId) && imageId > 0 ? imageId : null,
          rarity: typeof body.rarity === 'string' ? body.rarity : 'common',
          enabled: body.enabled !== false,
          condition: conditionCheck.value,
          sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
        },
        populate: { image: { select: ['url', 'width', 'height'] } },
      });
      ctx.send({ data: serializeCosmetic(created, 0, 0) });
    } catch (err: any) {
      if (String(err?.message || '').toLowerCase().includes('unique')) {
        return ctx.badRequest('同名装扮已存在');
      }
      throw err;
    }
  },

  /** PUT /management/cosmetics/:kind/:documentId —— 更新 */
  async updateCosmetic(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');
    const documentId = typeof ctx.params?.documentId === 'string' ? ctx.params.documentId : '';

    const existing = await strapi.db.query(cosmeticUid(kind)).findOne({
      where: { documentId },
      select: ['id'],
    });
    if (!existing) return ctx.notFound('Not found');

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 32) return ctx.badRequest('name 必填且不超过 32 字符');
      data.name = name;
    }
    if (body.description !== undefined) {
      data.description =
        typeof body.description === 'string' ? body.description.substring(0, 200) : null;
    }
    if (body.rarity !== undefined && typeof body.rarity === 'string') {
      data.rarity = body.rarity;
    }
    if (body.enabled !== undefined) {
      data.enabled = body.enabled !== false;
    }
    if (body.condition !== undefined) {
      const conditionCheck = validateConditionPayload(body.condition);
      if (conditionCheck.ok === false) return ctx.badRequest(conditionCheck.error);
      data.condition = conditionCheck.value;
    }
    if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
      data.sortOrder = Number(body.sortOrder);
    }
    if (body.imageId !== undefined) {
      const imageId = Number(body.imageId);
      data.image = Number.isFinite(imageId) && imageId > 0 ? imageId : null;
    }

    const updated = await strapi.db.query(cosmeticUid(kind)).update({
      where: { id: existing.id },
      data,
      populate: { image: { select: ['url', 'width', 'height'] } },
    });

    // 停用后：卸下所有用户装备中的该装扮（保留授予记录，重新启用后可再装备）。
    // 注意：updateMany 不支持 relation 字段（会被 processData 剥离成空 data），
    // 这里直接用 knex 清 link 表。
    if (data.enabled === false) {
      await unequipCosmeticFromAll(strapi, kind, existing.id);
    }

    ctx.send({ data: serializeCosmetic(updated, 0, 0) });
  },

  /** DELETE /management/cosmetics/:kind/:documentId —— 删除（存在生效授予时拒绝） */
  async deleteCosmetic(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');
    const documentId = typeof ctx.params?.documentId === 'string' ? ctx.params.documentId : '';

    const existing = await strapi.db.query(cosmeticUid(kind)).findOne({
      where: { documentId },
      select: ['id'],
    });
    if (!existing) return ctx.notFound('Not found');

    const relKey = relKeyOf(kind);
    const activeGrants = await strapi.db.query(grantUidOf(kind)).count({
      where: { [relKey]: { id: existing.id }, revokedAt: { $null: true } },
    });
    if (activeGrants > 0) {
      return ctx.badRequest(
        `仍有 ${activeGrants} 位用户持有该装扮，请先全部撤销（保留追溯记录）或改用停用`,
      );
    }

    // 卸下可能的历史装备（已撤销但仍装备着的防御性处理）
    await unequipCosmeticFromAll(strapi, kind, existing.id);

    await strapi.db.query(cosmeticUid(kind)).delete({ where: { id: existing.id } });
    ctx.send({ success: true });
  },

  /** POST /management/cosmetics/:kind/:documentId/grant —— 手动授予 */
  async grantCosmeticToUser(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');
    const documentId = typeof ctx.params?.documentId === 'string' ? ctx.params.documentId : '';

    const cosmetic = await strapi.db.query(cosmeticUid(kind)).findOne({
      where: { documentId },
      select: ['id', 'name'],
    });
    if (!cosmetic) return ctx.notFound('Not found');

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return ctx.badRequest('请填写授予原因（追溯留痕）');

    const targetUser = await resolveTargetUser(strapi, body);
    if (!targetUser) {
      return ctx.badRequest('找不到目标用户（支持 userId / username / userDocumentId）');
    }

    const result = await grantCosmetic(strapi, kind, {
      userId: targetUser.id,
      cosmeticId: cosmetic.id,
      source: 'manual',
      grantedByUserId: ctx.state?.user?.id ?? null,
      reason,
    });

    ctx.send({
      success: true,
      created: result.created,
      user: { id: targetUser.id, username: targetUser.username },
      cosmetic: { documentId, name: cosmetic.name },
    });
  },

  /** POST /management/cosmetics/:kind/:documentId/revoke —— 撤销（软删除，可复原） */
  async revokeCosmeticFromUser(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');
    const documentId = typeof ctx.params?.documentId === 'string' ? ctx.params.documentId : '';

    const cosmetic = await strapi.db.query(cosmeticUid(kind)).findOne({
      where: { documentId },
      select: ['id', 'name'],
    });
    if (!cosmetic) return ctx.notFound('Not found');

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reason) return ctx.badRequest('请填写撤销原因（追溯留痕）');

    const targetUser = await resolveTargetUser(strapi, body);
    if (!targetUser) {
      return ctx.badRequest('找不到目标用户（支持 userId / username / userDocumentId）');
    }

    const updated = await revokeCosmetic(strapi, kind, {
      userId: targetUser.id,
      cosmeticId: cosmetic.id,
      revokedByUserId: ctx.state?.user?.id ?? null,
      reason,
    });

    if (!updated) return ctx.badRequest('该用户当前没有这条装扮的生效授予');

    ctx.send({
      success: true,
      user: { id: targetUser.id, username: targetUser.username },
      cosmetic: { documentId, name: cosmetic.name },
    });
  },

  /** GET /management/cosmetics/:kind/grants —— 授予记录（可追溯） */
  async listGrants(ctx: any) {
    const kind = parseKind(ctx.params?.kind);
    if (!kind) return ctx.badRequest('kind 必须是 title 或 medal');
    const relKey = relKeyOf(kind);

    const { start, limit } = parsePagination(ctx.query?.start, ctx.query?.limit, 50, 20);
    const includeRevoked =
      ctx.query?.includeRevoked === 'true' || ctx.query?.includeRevoked === '1';

    const where: Record<string, unknown> = {};
    if (!includeRevoked) where.revokedAt = { $null: true };
    if (typeof ctx.query?.cosmeticDocumentId === 'string' && ctx.query.cosmeticDocumentId) {
      where[relKey] = { documentId: ctx.query.cosmeticDocumentId };
    }
    if (typeof ctx.query?.userDocumentId === 'string' && ctx.query.userDocumentId) {
      where.user = { documentId: ctx.query.userDocumentId };
    }
    if (typeof ctx.query?.username === 'string' && ctx.query.username.trim()) {
      where.user = { username: ctx.query.username.trim() };
    }
    if (ctx.query?.source === 'manual' || ctx.query?.source === 'auto') {
      where.source = ctx.query.source;
    }

    const [grants, total] = await Promise.all([
      strapi.db.query(grantUidOf(kind)).findMany({
        where,
        offset: start,
        limit,
        orderBy: { createdAt: 'desc' },
        populate: {
          user: { select: ['id', 'documentId', 'username'] },
          grantedBy: { select: ['id', 'username'] },
          revokedBy: { select: ['id', 'username'] },
          [relKey]: { select: ['id', 'documentId', 'name'] },
        },
      }),
      strapi.db.query(grantUidOf(kind)).count({ where }),
    ]);

    ctx.send({
      data: (grants || []).map((grant: any) => ({
        documentId: grant?.documentId,
        user: grant?.user
          ? {
              id: grant.user.id,
              documentId: grant.user.documentId,
              username: grant.user.username,
            }
          : null,
        cosmetic: grant?.[relKey]
          ? { documentId: grant[relKey].documentId, name: grant[relKey].name }
          : null,
        source: grant?.source ?? 'manual',
        grantedBy: grant?.grantedBy?.username ?? null,
        reason: grant?.reason ?? null,
        revokedAt: grant?.revokedAt ?? null,
        revokedBy: grant?.revokedBy?.username ?? null,
        revokeReason: grant?.revokeReason ?? null,
        createdAt: grant?.createdAt ?? null,
      })),
      meta: {
        pagination: {
          start,
          limit,
          total,
          pageCount: limit > 0 ? Math.ceil(total / limit) : 0,
        },
      },
    });
  },

  /** POST /management/cosmetics/evaluate —— 全量重评估（分批） */
  async evaluateAll(ctx: any) {
    const BATCH_SIZE = 100;
    let processed = 0;
    let granted = 0;
    let lastId = 0;

    for (;;) {
      const users = await strapi.db.query(USER_UID).findMany({
        where: { id: { $gt: lastId }, blocked: { $ne: true } },
        select: ['id'],
        orderBy: { id: 'asc' },
        limit: BATCH_SIZE,
      });
      if (!users?.length) break;

      for (const user of users) {
        try {
          granted += await evaluateAndGrantAuto(strapi, user.id);
        } catch (err) {
          strapi.log.warn(`[cosmetics] evaluate failed for user ${user.id}: ${err}`);
        }
        processed += 1;
        lastId = user.id;
      }

      if (users.length < BATCH_SIZE) break;
    }

    strapi.log.info(`[cosmetics] evaluate-all done: ${processed} users, ${granted} new grants`);
    ctx.send({ success: true, processed, granted });
  },
};
