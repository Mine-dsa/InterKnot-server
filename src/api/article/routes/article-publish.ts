export default {
  routes: [
    {
      method: 'POST',
      path: '/articles/:id/publish',
      handler: 'article.publishMine',
      config: {
        auth: {},
        policies: ['global::is-owner'],
        middlewares: ['global::require-exam-passed'],
      },
    },
  ],
};
