const AVATAR_UID = 'api::avatar.avatar';
const USER_UID = 'plugin::users-permissions.user';
const AUTHOR_UID = 'api::author.author';

function formatAvatar(avatar: any) {
  if (!avatar) return null;
  return {
    documentId: avatar.documentId ?? null,
    name: avatar.name ?? null,
    type: avatar.type ?? 'character',
    image: avatar.image ?? null,
  };
}

export default {
  async list(ctx: any) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    const avatars = await strapi.db.query(AVATAR_UID).findMany({
      populate: { image: { select: ['url', 'width', 'height'] } },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });

    const userRecord = await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      populate: { equippedAvatar: { select: ['documentId'] } },
    });

    const equippedDocumentId = userRecord?.equippedAvatar?.documentId ?? null;

    ctx.send({
      data: (avatars || []).map(formatAvatar),
      equippedAvatarDocumentId: equippedDocumentId,
    });
  },

  async equip(ctx: any) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const avatarDocumentId = typeof body?.documentId === 'string' ? body.documentId.trim() : null;

    if (avatarDocumentId) {
      const avatar = await strapi.db.query(AVATAR_UID).findOne({
        where: { documentId: avatarDocumentId },
        select: ['id'],
      });
      if (!avatar) return ctx.notFound('Avatar not found.');

      await strapi.db.query(USER_UID).update({
        where: { id: user.id },
        data: { equippedAvatar: avatar.id },
      });
    } else {
      await strapi.db.query(USER_UID).update({
        where: { id: user.id },
        data: { equippedAvatar: null },
      });
    }

    ctx.send({ success: true, equippedAvatarDocumentId: avatarDocumentId });
  },

  async uploadCustom(ctx: any) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const fileId = typeof body?.fileId === 'number' ? body.fileId : Number(body?.fileId);
    if (!Number.isFinite(fileId) || fileId <= 0) {
      return ctx.badRequest('fileId is required');
    }

    const fileRecord = await strapi.db.query('plugin::upload.file').findOne({
      where: { id: fileId },
      select: ['id', 'url', 'width', 'height'],
    });
    if (!fileRecord) return ctx.notFound('Uploaded file not found.');

    const userRecord = await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      populate: { author: { select: ['id', 'documentId'] } },
    });
    const authorId = userRecord?.author?.id;
    if (!authorId) return ctx.badRequest('Author profile not found.');

    const currentDenny = ((await strapi.db.query(USER_UID).findOne({ where: { id: user.id }, select: ['denny'] }))?.denny || 0);
    if (currentDenny < 10) return ctx.badRequest('丁尼余额不足');

    try {
      await strapi.db.connection('up_users').where({ id: user.id }).update({ denny: currentDenny - 10 });

      await strapi.db.query(AUTHOR_UID).update({
        where: { id: authorId },
        data: { avatar: fileRecord.id },
      });

      await strapi.db.query(USER_UID).update({
        where: { id: user.id },
        data: { equippedAvatar: null },
      });

      ctx.send({
        success: true,
        avatar: {
          url: fileRecord.url ?? null,
          width: fileRecord.width ?? null,
          height: fileRecord.height ?? null,
        },
      });
    } catch (err) {
      strapi.log.error('[avatar] Upload failed, refunding:', err);
      await strapi.db.connection('up_users').where({ id: user.id }).update({ denny: currentDenny });
      return ctx.internalServerError('设置头像失败，已退还丁尼');
    }
  },
};
