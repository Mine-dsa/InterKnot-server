export default {
  register() {}, 

  async bootstrap({ strapi }: any) {
    strapi.db.lifecycles.subscribe({
      models: ['plugin::users-permissions.user'],
      async afterCreate(event: any) {
        await ensureAuthorForUser(event, strapi);
      },
    });
  },
};

async function ensureAuthorForUser(event: any, strapi: any) {
  const { result } = event;
  if (!result?.id) return;
  try {
    const exists = await strapi.db
      .query('api::author.author')
      .findOne({ where: { user: result.id } });
    if (!exists) {
      await strapi.documents('api::author.author').create({
        data: { name: result.username, slug: `user-${result.id}`, user: result.id },
      });
    }
  } catch (err) {
    strapi.log.error(`Author creation error: ${err}`);
  }
}
