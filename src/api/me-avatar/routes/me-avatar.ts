export default {
  routes: [
    { method: 'GET', path: '/me/avatars', handler: 'me-avatar.list',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'PUT', path: '/me/avatars/equip', handler: 'me-avatar.equip',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
    { method: 'PUT', path: '/me/avatars/upload-custom', handler: 'me-avatar.uploadCustom',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] } },
  ],
};
