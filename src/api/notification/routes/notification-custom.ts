export default {
  routes: [
    {
      method: 'GET',
      path: '/notifications/list',
      handler: 'notification.list',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/notifications/unread-count',
      handler: 'notification.unreadCount',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'PUT',
      path: '/notifications/:id/mark-read',
      handler: 'notification.markAsRead',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'PUT',
      path: '/notifications/mark-all-read',
      handler: 'notification.markAllAsRead',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/knock/conversations',
      handler: 'notification.listConversations',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'GET',
      path: '/knock/conversations/:id/messages',
      handler: 'notification.listMessages',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'POST',
      path: '/knock/conversations/:id/mark-read',
      handler: 'notification.markConversationRead',
      config: {
        auth: {},
        policies: [],
      },
    },
    {
      method: 'POST',
      path: '/knock/stream-ticket',
      handler: 'notification.sseTicket',
      config: {
        // EventSource 不支持自定义 header：先带 JWT 领一次性 ticket，再 ?ticket= 连 SSE
        auth: false,
        policies: [],
        middlewares: ['global::require-auth'],
      },
    },
    {
      method: 'GET',
      path: '/knock/stream',
      handler: 'notification.stream',
      config: {
        // EventSource 不支持自定义 header，controller 里手动验证 ?ticket=（一次性票据）
        auth: false,
        policies: [],
      },
    },
  ],
};
