export default {
  routes: [
    {
      method: 'GET',
      path: '/me/profile',
      handler: 'me-profile.get',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/me/profile/name',
      handler: 'me-profile.updateName',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/me/profile/bio',
      handler: 'me-profile.updateBio',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/me/profile/visibility',
      handler: 'me-profile.updateVisibility',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'GET',
      path: '/me/profile/pinned-articles',
      handler: 'me-profile.getPinnedArticles',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'PUT',
      path: '/me/profile/pinned-articles',
      handler: 'me-profile.updatePinnedArticles',
      config: { auth: false, policies: [], middlewares: ['global::optional-auth'] },
    },
    {
      method: 'GET',
      path: '/me/ai-assistant',
      handler: 'me-profile.aiAssistant',
      config: { auth: false, policies: [], middlewares: [] },
    },
  ],
};
