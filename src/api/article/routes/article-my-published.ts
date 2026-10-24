export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/my/published',
      handler: 'article.myPublishedListLite',
      config: {
        auth: {},
        policies: [],
      },
    },
  ],
};
