const CARD_UID = 'api::business-card.business-card';
const USER_UID = 'plugin::users-permissions.user';
const VALID_CARD_TYPES = new Set(['character', 'city', 'news']);

function formatCard(card: any) {
  if (!card) return null;
  return {
    documentId: card.documentId ?? null,
    name: card.name ?? null,
    description: card.description ?? null,
    story: card.story ?? null,
    type: card.type ?? 'character',
    image: card.image ?? null,
  };
}

export default {
  async list(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    const queryType = typeof ctx.query?.type === 'string' ? ctx.query.type.trim() : '';
    if (queryType && !VALID_CARD_TYPES.has(queryType)) {
      return ctx.badRequest('Invalid card type.');
    }

    // Fetch business cards
    const cards = await strapi.db.query(CARD_UID).findMany({
      where: queryType ? { type: queryType } : {},
      populate: {
        image: { select: ['url', 'width', 'height'] },
      },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });

    // Get user's equipped card
    const userRecord = await strapi.db.query(USER_UID).findOne({
      where: { id: user.id },
      populate: {
        equippedCard: {
          populate: {
            image: { select: ['url', 'width', 'height'] },
          },
        },
      },
    });

    const equippedDocumentId = userRecord?.equippedCard?.documentId ?? null;

    ctx.send({
      data: (cards || []).map(formatCard),
      equippedCardDocumentId: equippedDocumentId,
      equippedCard: formatCard(userRecord?.equippedCard),
    });
  },

  async equip(ctx) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    const body = ctx.request.body as Record<string, unknown> | undefined;
    const cardDocumentId = typeof body?.documentId === 'string' ? body.documentId.trim() : null;

    if (cardDocumentId) {
      // Verify card exists
      const card = await strapi.db.query(CARD_UID).findOne({
        where: { documentId: cardDocumentId },
        select: ['id'],
      });

      if (!card) return ctx.notFound('Card not found.');

      await strapi.db.query(USER_UID).update({
        where: { id: user.id },
        data: { equippedCard: card.id },
      });
    } else {
      await strapi.db.query(USER_UID).update({
        where: { id: user.id },
        data: { equippedCard: null },
      });
    }

    ctx.send({ success: true, equippedCardDocumentId: cardDocumentId });
  },
};
