export default {
  routes: [
    {
      method: 'GET',
      path: '/profiles/:documentId/comments',
      handler: 'author.profileComments',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};
