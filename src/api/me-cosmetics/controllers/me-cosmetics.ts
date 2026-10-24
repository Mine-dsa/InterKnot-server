/**
 * me-cosmetics controller
 *
 * 用户侧称号/勋章：
 *  GET /api/me/titles|medals       目录（含解锁状态；触发懒评估）
 *  PUT /api/me/titles|medals/equip 装备/卸下（需已解锁）
 */
import {
  CosmeticsKind,
  cosmeticUid,
  describeCondition,
  evaluateAndGrantAuto,
  normalizeCondition,
} from '../../../utils/cosmetics';

const USER_UID = 'plugin::users-permissions.user';

type SerializedCosmetic = {
  documentId: string;
  name: string;
  description: string | null;
  image: unknown;
  rarity: string;
  conditionDescription: string;
  unlocked: boolean;
  unlockSource: 'manual' | 'auto' | null;
  unlockedAt: string | null;
};

const listForKind = (kind: CosmeticsKind) => async (ctx: any) => {
  const user = ctx.state?.user;
  if (!user?.id) return ctx.unauthorized('You must be logged in.');

  // 懒评估：打开面板时刷新一次自动授予（条件达成但未记录的会在此补发）
  try {
    await evaluateAndGrantAuto(strapi, user.id);
  } catch (err) {
    strapi.log.warn(`[cosmetics] lazy evaluate failed for user ${user.id}: ${err}`);
  }

  const relKey = kind === 'title' ? 'title' : 'medal';
  const grantQuery = strapi.db.query(
    kind === 'title' ? 'api::title-grant.title-grant' : 'api::medal-grant.medal-grant',
  );

  const [cosmetics, grants, userRecord] = await Promise.all([
    strapi.db.query(cosmeticUid(kind)).findMany({
      populate: { image: { select: ['url', 'width', 'height'] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    grantQuery.findMany({
      where: { user: { id: user.id } },
      select: ['source', 'createdAt', 'revokedAt'],
      populate: { [relKey]: { select: ['id'] } },
      limit: 1000,
    }),
    strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      populate: { [relKey]: { select: ['documentId'] } },
    }),
  ]);

  const activeGrantByCosmeticId = new Map<number, { source: string; createdAt: string }>();
  for (const grant of grants || []) {
    if (grant?.revokedAt) continue;
    const cosmeticId = grant?.[relKey]?.id;
    if (typeof cosmeticId === 'number') {
      activeGrantByCosmeticId.set(cosmeticId, {
        source: grant.source ?? 'manual',
        createdAt: grant.createdAt ?? null,
      });
    }
  }

  const data: SerializedCosmetic[] = (cosmetics || [])
    .filter((item: any) => item?.enabled !== false)
    .map((item: any) => {
      const active = activeGrantByCosmeticId.get(item.id);
      return {
        documentId: item.documentId,
        name: item.name,
        description: item.description ?? null,
        image: item.image ?? null,
        rarity: item.rarity ?? 'common',
        conditionDescription: describeCondition(normalizeCondition(item.condition)),
        unlocked: !!active,
        unlockSource: (active?.source as 'manual' | 'auto' | undefined) ?? null,
        unlockedAt: active?.createdAt ?? null,
      };
    });

  ctx.send({
    data,
    [kind === 'title' ? 'equippedTitleDocumentId' : 'equippedMedalDocumentId']:
      userRecord?.[relKey]?.documentId ?? null,
  });
};

const equipForKind = (kind: CosmeticsKind) => async (ctx: any) => {
  const user = ctx.state?.user;
  if (!user?.id) return ctx.unauthorized('You must be logged in.');

  const body = ctx.request.body as Record<string, unknown> | undefined;
  const rawDocumentId = body?.documentId;
  const documentId =
    typeof rawDocumentId === 'string' && rawDocumentId.trim() ? rawDocumentId.trim() : null;

  const equipField = kind === 'title' ? 'equippedTitle' : 'equippedMedal';
  const relKey = kind === 'title' ? 'title' : 'medal';

  if (!documentId) {
    await strapi.db.query(USER_UID).update({
      where: { id: user.id },
      data: { [equipField]: null },
    });
    ctx.send({ success: true, [`${equipField}DocumentId`]: null });
    return;
  }

  const cosmetic = await strapi.db.query(cosmeticUid(kind)).findOne({
    where: { documentId },
    select: ['id', 'enabled'],
  });
  if (!cosmetic) return ctx.notFound('Not found.');
  if (cosmetic.enabled === false) return ctx.badRequest('该装扮已被管理员停用');

  // 必须存在生效授予记录才能装备
  const grant = await strapi.db
    .query(kind === 'title' ? 'api::title-grant.title-grant' : 'api::medal-grant.medal-grant')
    .findOne({
      where: {
        user: { id: user.id },
        [relKey]: { id: cosmetic.id },
        revokedAt: { $null: true },
      },
      select: ['id'],
    });
  if (!grant) return ctx.forbidden('尚未获得该装扮');

  await strapi.db.query(USER_UID).update({
    where: { id: user.id },
    data: { [equipField]: cosmetic.id },
  });

  ctx.send({ success: true, [`${equipField}DocumentId`]: documentId });
};

export default {
  listTitles: listForKind('title'),
  equipTitle: equipForKind('title'),
  listMedals: listForKind('medal'),
  equipMedal: equipForKind('medal'),
};
