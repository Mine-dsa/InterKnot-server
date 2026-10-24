export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/my/drafts',
      handler: 'article.myDraftsOnlyLite',
      config: {
        auth: {},
        policies: [],
      },
    },
  ],
};
