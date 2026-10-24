export default {
  routes: [
    { method: 'GET', path: '/user-denny', handler: 'user-denny.getBalance',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'POST', path: '/user-denny/give', handler: 'user-denny.giveToArticle',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth', 'global::require-exam-passed'] } },
  ],
};
