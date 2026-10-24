export default {
  routes: [
    {
      method: 'GET',
      path: '/comments/list',
      handler: 'comment.listLite',
      config: {
        auth: false,
        middlewares: ['global::optional-auth'],
        policies: [],
      },
    },
  ],
};
