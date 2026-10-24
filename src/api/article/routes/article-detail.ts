export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/detail/:documentId',
      handler: 'article.detailLite',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};
