export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  const documentId = policyContext.params?.id;
  if (!documentId) return false;

  const commentByDocumentId = await strapi.documents('api::comment.comment').findOne({
    documentId,
    populate: {
      author: {
        populate: ['user'],
      },
    },
  });

  let authorUserId = commentByDocumentId?.author?.user?.id;

  if (!authorUserId) {
    const asNumber = Number.parseInt(String(documentId), 10);
    if (!Number.isNaN(asNumber)) {
      const commentById = await strapi.db.query('api::comment.comment').findOne({
        where: { id: asNumber },
        populate: {
          author: {
            populate: ['user'],
          },
        },
      });
      authorUserId = commentById?.author?.user?.id;
    }
  }

  return !!authorUserId && authorUserId === user.id;
};
