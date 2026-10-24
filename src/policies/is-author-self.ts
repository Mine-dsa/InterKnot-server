export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  const data = policyContext.request?.body?.data;
  const rawAuthor = data?.author;
  if (!rawAuthor) return false;

  let authorId: number | undefined;
  let authorDocumentId: string | undefined;

  if (typeof rawAuthor === 'object' && rawAuthor !== null) {
    if (rawAuthor.id) authorId = rawAuthor.id;
    if (rawAuthor.documentId) authorDocumentId = rawAuthor.documentId;
    const connect = rawAuthor.connect;
    if (Array.isArray(connect) && connect.length > 0) {
      if (connect[0]?.id) authorId = connect[0].id;
      if (connect[0]?.documentId) authorDocumentId = connect[0].documentId;
    }
  } else if (typeof rawAuthor === 'number') {
    authorId = rawAuthor;
  } else if (typeof rawAuthor === 'string') {
    const asInt = Number.parseInt(rawAuthor, 10);
    if (!Number.isNaN(asInt) && asInt.toString() === rawAuthor) {
      authorId = asInt;
    } else {
      authorDocumentId = rawAuthor;
    }
  }

  if (!authorId && !authorDocumentId) return false;

  const where = authorId ? { id: authorId } : { documentId: authorDocumentId };
  const author = await strapi.db
    .query('api::author.author')
    .findOne({ where, populate: ['user'] });

  return author?.user?.id === user.id;
};
