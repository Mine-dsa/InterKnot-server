export default {
  routes: [
    { method: 'POST', path: '/likes/toggle', handler: 'like.toggle',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth', 'global::require-exam-passed'] } },
    { method: 'GET', path: '/likes/check', handler: 'like.check',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'GET', path: '/likes/my-list', handler: 'like.myList',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
  ],
};
