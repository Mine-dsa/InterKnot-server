export default {
  routes: [
    {
      method: 'GET',
      path: '/favorites/list',
      handler: 'favorite.listLite',
      config: {
        auth: {},
        policies: [],
      },
    },
  ],
};
