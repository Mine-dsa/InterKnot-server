export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/my',
      handler: 'article.myListLite',
      config: {
        auth: {},
        policies: [],
      },
    },
  ],
};
