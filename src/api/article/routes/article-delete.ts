export default {
  routes: [
    {
      method: 'DELETE',
      path: '/articles/:id',
      handler: 'article.deleteMine',
      config: {
        auth: {},
        policies: ['global::is-owner'],
      },
    },
  ],
};
