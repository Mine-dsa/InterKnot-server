export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/my/detail/:id',
      handler: 'article.myDetailLite',
      config: {
        auth: {},
        policies: ['global::is-owner'],
      },
    },
  ],
};
