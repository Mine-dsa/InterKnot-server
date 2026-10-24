export default {
  routes: [
    {
      method: 'POST',
      path: '/articles/:documentId/view',
      handler: 'article.incrementView',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};