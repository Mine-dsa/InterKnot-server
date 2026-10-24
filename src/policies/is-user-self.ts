export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  const documentId = policyContext.params?.id;
  const data = policyContext.request?.body?.data;

  if (!documentId) {
    const rawUser = data?.user;
    if (!rawUser) return false;

    let userId: number | undefined;
    if (typeof rawUser === 'object' && rawUser !== null) {
      if (rawUser.id) userId = rawUser.id;
      const connect = rawUser.connect;
      if (Array.isArray(connect) && connect.length > 0) {
        if (connect[0]?.id) userId = connect[0].id;
      }
    } else if (typeof rawUser === 'number') {
      userId = rawUser;
    } else if (typeof rawUser === 'string') {
      const asInt = Number.parseInt(rawUser, 10);
      if (!Number.isNaN(asInt) && asInt.toString() === rawUser) {
        userId = asInt;
      }
    }

    return userId === user.id;
  }

  const record = await strapi.documents('api::article-read.article-read').findOne({
    documentId,
    populate: {
      user: true,
    },
  });

  if (!record?.user?.id) return false;
  return record.user.id === user.id;
};
