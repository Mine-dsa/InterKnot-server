/**
 * 名片管理控制器（/management/cards/*）
 *
 * 名片 = 玩家个人主页顶部的卡片背景（business-card 条目）。
 * 管理员上传（前端已裁剪成图）→ 显示在所有用户的名片选择列表。
 * 管理端点仅做条目管理；用户装备/列表沿用既有 me-business-card 端点，零改动。
 *
 * 可控制 / 可追溯 / 可复原：
 * - 列表展示每张名片被装备的人数；
 * - 删除前提示持有者数量，删除时自动卸下所有用户的装备（保留条目历史由管理员自行备份）。
 */
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';

const CARD_UID = 'api::business-card.business-card';
const USER_UID = 'plugin::users-permissions.user';

const CARD_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

/** 卸下所有用户装备中的指定名片（清 link 表，同 cosmetics 的 unequip 方案） */
async function unequipCardFromAll(strapi: any, cardId: number) {
  try {
    await strapi.db.connection('up_users_equipped_card_lnk')
      .where({ business_card_id: cardId })
      .del();
  } catch (err) {
    strapi.log.warn(`[cards] unequip-all failed for card#${cardId}: ${err}`);
  }
}

function serializeCard(item: any, equipCount: number) {
  return {
    documentId: item?.documentId ?? null,
    name: item?.name ?? '',
    description: item?.description ?? null,
    type: item?.type ?? 'character',
    image: item?.image ?? null,
    equipCount,
    createdAt: item?.createdAt ?? null,
  };
}

export default {
  /** GET /management/cards —— 名片列表（含被装备人数） */
  async listCards(ctx: any) {
    const cards = await strapi.db.query(CARD_UID).findMany({
      populate: { image: { select: ['url', 'width', 'height'] } },
      orderBy: { createdAt: 'desc' },
      limit: 500,
    });

    // 被装备人数：link 表计数（单查询，避免 N+1）
    let countByCard = new Map<number, number>();
    try {
      const rows = await strapi.db.connection('up_users_equipped_card_lnk')
        .select('business_card_id')
        .count('* as cnt')
        .groupBy('business_card_id');
      countByCard = new Map(
        (rows || []).map((r: any) => [Number(r.business_card_id), Number(r.cnt || 0)]),
      );
    } catch (err) {
      strapi.log.warn(`[cards] equip count failed: ${err}`);
    }

    ctx.send({
      data: (cards || []).map((item: any) =>
        serializeCard(item, countByCard.get(item.id) ?? 0),
      ),
    });
  },

  /**
   * POST /management/cards/upload —— 上传新名片
   * multipart：files（前端已按名片比例裁剪的图）+ name（必填）
   * 控制器调 upload service 落盘后创建 business-card 条目。
   */
  async uploadCard(ctx: any) {
    const body = ctx.request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 32) {
      return ctx.badRequest('name 必填且不超过 32 字符');
    }

    // formidable 解析结果：单文件或数组
    let file: any = ctx.request.files?.files;
    if (Array.isArray(file)) file = file[0];
    if (!file?.filepath || !file?.size) {
      return ctx.badRequest('缺少图片文件（files 字段）');
    }
    const mime = String(file.mimetype || '').toLowerCase();
    if (!CARD_MIMES.has(mime)) {
      return ctx.badRequest(`不支持的图片格式: ${mime || '未知'}（仅支持 jpeg/png/webp/gif/avif）`);
    }

    // 1. 经 upload service 落盘（生成缩略图等与后台上传行为一致）
    const uploaded = await strapi.plugin('upload').service('upload').upload({
      data: {
        fileInfo: { name, alternativeText: `名片：${name}`, caption: null },
      },
      files: [
        {
          filepath: file.filepath,
          originalFilename: file.originalFilename || `card.${mime.split('/')[1] || 'png'}`,
          mimetype: mime,
          size: file.size,
        },
      ],
    });

    const imageId = uploaded?.[0]?.id;
    if (!imageId) {
      return ctx.internalServerError('图片保存失败');
    }

    // 2. 创建名片条目（出现在所有用户的名片选择列表）
    const card = await strapi.db.query(CARD_UID).create({
      data: {
        name,
        type: 'character',
        image: imageId,
      },
      populate: { image: { select: ['url', 'width', 'height'] } },
    });

    // 3. 生成 -small.webp 缩略图（项目展示约定：profile 等出口会把
    //    image.url 加 `-small.webp` 后缀取小图，如 author.profile）。
    //    名片为 3:1 横幅，缩略按宽 720 保持比例，供 banner 显示足够清晰。
    try {
      const url = String(uploaded?.[0]?.url || '');
      if (url.startsWith('/uploads/')) {
        const srcPath = path.join(process.cwd(), 'public', url);
        const smallPath = srcPath + '-small.webp';
        if (fs.existsSync(srcPath) && !fs.existsSync(smallPath)) {
          await sharp(srcPath).resize({ width: 720 }).webp({ quality: 80 }).toFile(smallPath);
        }
      }
    } catch (err) {
      // 缩略图生成失败不影响原图；但展示端 -small.webp 会 404，需删除重传
      strapi.log.warn(`[cards] small webp generation failed for「${name}」: ${err}`);
    }

    strapi.log.info(`[cards] 管理员 ${ctx.state?.user?.id} 上传名片「${name}」 (${card.documentId})`);
    ctx.send({ data: serializeCard(card, 0) });
  },

  /** PUT /management/cards/:documentId —— 改名 */
  async renameCard(ctx: any) {
    const documentId = typeof ctx.params?.documentId === 'string' ? ctx.params.documentId : '';
    const body = ctx.request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 32) return ctx.badRequest('name 必填且不超过 32 字符');

    const existing = await strapi.db.query(CARD_UID).findOne({
      where: { documentId },
      select: ['id'],
    });
    if (!existing) return ctx.notFound('Not found');

    await strapi.db.query(CARD_UID).update({
      where: { id: existing.id },
      data: { name },
      populate: { image: { select: ['url', 'width', 'height'] } },
    });

    ctx.send({ success: true, name });
  },

  /** DELETE /management/cards/:documentId —— 删除（自动卸下所有持有者） */
  async deleteCard(ctx: any) {
    const documentId = typeof ctx.params?.documentId === 'string' ? ctx.params.documentId : '';
    const existing = await strapi.db.query(CARD_UID).findOne({
      where: { documentId },
      select: ['id', 'name'],
    });
    if (!existing) return ctx.notFound('Not found');

    const holders = await strapi.db.query(USER_UID).findMany({
      where: { equippedCard: { id: existing.id } },
      select: ['id'],
      limit: 10000,
    });
    for (const u of holders) {
      await strapi.db.query(USER_UID).update({
        where: { id: u.id },
        data: { equippedCard: null },
      });
    }

    await strapi.db.query(CARD_UID).delete({ where: { id: existing.id } });

    strapi.log.info(`[cards] 管理员 ${ctx.state?.user?.id} 删除名片「${existing.name}」（卸下 ${holders.length} 位持有者）`);
    ctx.send({ success: true, unequipped: holders.length });
  },
};
