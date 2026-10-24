export default {
  routes: [
    { method: 'GET', path: '/tip-config', handler: 'tip-config.get',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'PUT', path: '/tip-config', handler: 'tip-config.update',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
  ],
};
