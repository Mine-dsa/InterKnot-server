export default {
  routes: [
    {
      method: 'POST',
      path: '/article-reads/batch',
      handler: 'article-read.batch',
      config: {
        auth: {},
      },
    },
  ],
};
