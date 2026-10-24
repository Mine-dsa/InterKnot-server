export default {
  routes: [
    { method: 'POST', path: '/favorites/toggle', handler: 'favorite.toggle',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth', 'global::require-exam-passed'] } },
    { method: 'GET', path: '/favorites/check', handler: 'favorite.check',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
  ],
};
