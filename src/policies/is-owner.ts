export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state?.user;
  if (!user) return false;

  const documentId = policyContext.params?.id || policyContext.params?.documentId;
  if (!documentId) return false;

  // 优先查 published，查不到再查 draft（首次发布时 published 版本不存在）
  const requestStatus = policyContext.query?.status || policyContext.request?.query?.status;
  const findOpts = {
    documentId,
    populate: { author: { populate: ['user'] } },
  };
  let article = await strapi.documents('api::article.article').findOne({
    ...findOpts,
    status: requestStatus === 'draft' ? 'draft' : 'published',
  });
  if (!article) {
    article = await strapi.documents('api::article.article').findOne({
      ...findOpts,
      status: 'draft',
    });
  }

  // 已发布的匿名帖不可编辑或删除；草稿阶段允许编辑
  if (article?.isAnonymous && article?.publishedAt) return false;

  const authorUserId = article?.author?.user?.id;
  return !!authorUserId && authorUserId === user.id;
};
