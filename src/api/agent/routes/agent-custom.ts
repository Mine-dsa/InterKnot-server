const INTERNAL = {
  auth: false,
  middlewares: ['global::agent-internal'],
} as const;

export default {
  routes: [
    {
      method: 'GET',
      path: '/agent/characters',
      handler: 'api::agent.agent.characters',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/agent/config',
      handler: 'api::agent.agent.config',
      config: INTERNAL,
    },
    {
      method: 'GET',
      path: '/agent/resolve',
      handler: 'api::agent.agent.resolve',
      config: INTERNAL,
    },
    {
      method: 'GET',
      path: '/agent/context/comment/:id',
      handler: 'api::agent.agent.contextComment',
      config: INTERNAL,
    },
    {
      method: 'GET',
      path: '/agent/context/dm/:id',
      handler: 'api::agent.agent.contextDm',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/reply-comment',
      handler: 'api::agent.agent.replyComment',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/reply-dm',
      handler: 'api::agent.agent.replyDm',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/dm-typing',
      handler: 'api::agent.agent.dmTyping',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/dm-stream-start',
      handler: 'api::agent.agent.dmStreamStart',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/dm-stream-delta',
      handler: 'api::agent.agent.dmStreamDelta',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/dm-stream-finish',
      handler: 'api::agent.agent.dmStreamFinish',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/quota-check',
      handler: 'api::agent.agent.quotaCheck',
      config: INTERNAL,
    },
    {
      method: 'POST',
      path: '/agent/internal/job-log',
      handler: 'api::agent.agent.logJob',
      config: INTERNAL,
    },
    {
      method: 'GET',
      path: '/agent/internal/dead-letter',
      handler: 'api::agent.agent.deadLetter',
      config: INTERNAL,
    },

    {
      method: 'POST',
      path: '/agent/internal/tool',
      handler: 'api::agent.agent.executeTool',
      config: INTERNAL,
    },
  ],
};
