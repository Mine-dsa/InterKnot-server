export default {
  routes: [
    {
      method: 'GET',
      path: '/profiles/:documentId',
      handler: 'author.profile',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};
