export default {
  routes: [
    { method: 'POST', path: '/follows/toggle', handler: 'follow.toggle',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth', 'global::require-exam-passed'] } },
    { method: 'GET', path: '/follows/check', handler: 'follow.check',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'GET', path: '/follows/following', handler: 'follow.followingList',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
  ],
};
