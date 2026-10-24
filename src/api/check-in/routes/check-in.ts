export default {
  routes: [
    { method: 'POST', path: '/check-in', handler: 'check-in.checkIn',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'GET', path: '/check-in/status', handler: 'check-in.getStatus',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
  ],
};
