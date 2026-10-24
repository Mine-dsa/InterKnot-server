export default {
  routes: [
    {
      method: 'GET',
      path: '/me/exp',
      handler: 'user-exp.get',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
