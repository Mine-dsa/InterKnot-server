export default {
  routes: [
    {
      method: 'GET',
      path: '/me/uploads',
      handler: 'me-upload.list',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
