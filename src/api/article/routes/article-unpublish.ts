export default {
  routes: [
    {
      method: 'POST',
      path: '/articles/:id/unpublish',
      handler: 'article.unpublishMine',
      config: {
        auth: {},
        policies: ['global::is-owner'],
        middlewares: ['global::require-exam-passed'],
      },
    },
  ],
};
