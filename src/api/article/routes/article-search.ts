export default {
  routes: [
    {
      method: 'GET',
      path: '/articles/search',
      handler: 'article.searchLite',
      config: {
        auth: false,
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/articles/suggest',
      handler: 'article.suggestLite',
      config: {
        auth: false,
        policies: [],
      },
    },
  ],
};
