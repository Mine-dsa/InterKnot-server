export default {
  routes: [
    {
      method: 'GET',
      path: '/me/business-cards',
      handler: 'me-business-card.list',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/me/business-cards/equip',
      handler: 'me-business-card.equip',
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
