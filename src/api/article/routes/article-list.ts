export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/list',
      handler: 'article.listLite',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};
