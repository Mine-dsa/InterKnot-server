export default {
  routes: [
    {
      method: 'GET',
      path: '/checkin-simple/status',
      handler: 'checkin-simple.status',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'POST',
      path: '/checkin-simple/checkin',
      handler: 'checkin-simple.checkin',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'GET',
      path: '/checkin-simple/config',
      handler: 'checkin-simple.getConfig',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/checkin-simple/config',
      handler: 'checkin-simple.updateConfig',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
  ],
};
