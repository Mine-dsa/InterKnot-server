export default {
  routes: [
    {
      method: 'GET',
      path: '/management/users',
      handler: 'admin.listUsers',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'GET',
      path: '/management/users/:id',
      handler: 'admin.getUser',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'PUT',
      path: '/management/users/:id',
      handler: 'admin.updateUser',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'DELETE',
      path: '/management/users/:id',
      handler: 'admin.deleteUser',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'GET',
      path: '/management/articles',
      handler: 'admin.listArticles',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'DELETE',
      path: '/management/articles/:id',
      handler: 'admin.deleteArticle',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'PUT',
      path: '/management/articles/:id',
      handler: 'admin.updateArticle',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'GET',
      path: '/management/articles/:id/images',
      handler: 'admin.listArticleImages',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/articles/:id/covers',
      handler: 'admin.addArticleCover',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/articles/:id/covers/order',
      handler: 'admin.reorderArticleCovers',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'PUT',
      path: '/management/articles/:id/covers/:fileId',
      handler: 'admin.replaceArticleCover',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'DELETE',
      path: '/management/articles/:id/covers/:fileId',
      handler: 'admin.deleteArticleCover',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/articles/:id/inline/remove',
      handler: 'admin.removeInlineImage',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/articles/:id/inline/replace',
      handler: 'admin.replaceInlineImage',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/users/:id/avatar',
      handler: 'admin.setUserAvatar',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/upload',
      handler: 'admin.uploadMedia',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'GET',
      path: '/management/reports',
      handler: 'admin.listReports',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'DELETE',
      path: '/management/reports/:id',
      handler: 'admin.deleteReport',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'GET',
      path: '/management/comments',
      handler: 'admin.listComments',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'DELETE',
      path: '/management/comments/:id',
      handler: 'admin.deleteComment',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/announcements',
      handler: 'admin.createAnnouncement',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::admin-auth'],
      },
    },
    {
      method: 'POST',
      path: '/management/setup-first-admin',
      handler: 'admin.setupFirstAdmin',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth'],
      },
    },
  ],
};
