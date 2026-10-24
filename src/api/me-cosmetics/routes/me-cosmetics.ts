export default {
  routes: [
    {
      method: 'GET',
      path: '/me/titles',
      handler: 'me-cosmetics.listTitles',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/me/titles/equip',
      handler: 'me-cosmetics.equipTitle',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'GET',
      path: '/me/medals',
      handler: 'me-cosmetics.listMedals',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/me/medals/equip',
      handler: 'me-cosmetics.equipMedal',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
  ],
};
