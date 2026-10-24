export default {
  routes: [
    {
      method: 'GET',
      path: '/exam/status',
      handler: 'exam.status',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth'],
      },
    },
    {
      method: 'POST',
      path: '/exam/start',
      handler: 'exam.start',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth'],
      },
    },
    {
      method: 'POST',
      path: '/exam/submit',
      handler: 'exam.submit',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth'],
      },
    },
  ],
};
