export default {
  routes: [
    {
      method: 'GET',
      path: '/profiles/:documentId/articles',
      handler: 'author.profileArticles',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};
