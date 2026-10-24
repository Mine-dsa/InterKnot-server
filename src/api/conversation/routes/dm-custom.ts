/**
 * DM 私聊全部路由集中注册（前缀 /api/dm）。
 *
 * 之所以放在 conversation API 下：conversation 是聚合中心，message 与
 * conversation-member 都从属于 conversation。这样前端只看一个路由文件就能
 * 通览全貌；message / conversation-member 不再各自维护 dm-* 路由。
 *
 * 不开放 Strapi 默认 CRUD 路由：所有 schema 都不让前端走 entity-service
 * 通用增删改查（避免越权写）；现在唯一暴露的就是这里列出的端点。
 *
 * 鉴权约定（重要）：
 * 所有 DM endpoint 的 controller 内部都已显式做 `ctx.state.user` + 成员关系
 * 检查。Strapi `auth: {}` 会按 controller.action 自动推断 user-permissions
 * scope（admin UI 上 custom action 经常不显示或漏勾），导致 403 Forbidden。
 * 这里统一改用 `auth: false` + `global::require-auth` middleware：
 *  - 关闭 user-permissions 的自动 scope 检查
 *  - 由 require-auth 强制解析 jwt 并填充 ctx.state.user
 *  - 任何未登录的请求都被 require-auth 直接 401 返回
 * 这样新增 DM endpoint 不再需要去 admin UI 勾权限。
 */
const DM_AUTH = { auth: false, middlewares: ['global::require-auth'] } as const;
// 写操作额外要求已通过入站考试（require-exam-passed 必须排在 require-auth 之后）
const DM_AUTH_WRITE = {
  auth: false,
  middlewares: ['global::require-auth', 'global::require-exam-passed'],
} as const;

export default {
  routes: [
    /* ───── 会话相关（conversation controller） ───── */
    {
      method: 'GET',
      path: '/dm/conversations',
      handler: 'api::conversation.conversation.list',
      config: DM_AUTH,
    },
    {
      method: 'POST',
      path: '/dm/conversations/direct',
      handler: 'api::conversation.conversation.direct',
      config: DM_AUTH_WRITE,
    },
    {
      method: 'POST',
      path: '/dm/conversations/group',
      handler: 'api::conversation.conversation.createGroup',
      config: DM_AUTH_WRITE,
    },
    {
      method: 'GET',
      path: '/dm/conversations/:id',
      handler: 'api::conversation.conversation.detail',
      config: DM_AUTH,
    },
    {
      method: 'PATCH',
      path: '/dm/conversations/:id',
      handler: 'api::conversation.conversation.update',
      config: DM_AUTH,
    },
    {
      method: 'PATCH',
      path: '/dm/conversations/:id/read',
      handler: 'api::conversation.conversation.markRead',
      config: DM_AUTH,
    },
    {
      method: 'POST',
      path: '/dm/conversations/:id/leave',
      handler: 'api::conversation.conversation.leave',
      config: DM_AUTH,
    },
    {
      method: 'POST',
      path: '/dm/conversations/:id/members',
      handler: 'api::conversation.conversation.addMembers',
      config: DM_AUTH_WRITE,
    },
    {
      method: 'DELETE',
      path: '/dm/conversations/:id/members/:userId',
      handler: 'api::conversation.conversation.removeMember',
      config: DM_AUTH,
    },
    {
      method: 'POST',
      path: '/dm/conversations/:id/reset-context',
      handler: 'api::conversation.conversation.resetContext',
      config: DM_AUTH,
    },
    {
      method: 'POST',
      path: '/dm/socket/ticket',
      handler: 'api::conversation.conversation.wsTicket',
      config: DM_AUTH,
    },

    /* ───── 消息相关（message controller） ───── */
    {
      method: 'GET',
      path: '/dm/conversations/:id/messages',
      handler: 'api::message.message.list',
      config: DM_AUTH,
    },
    {
      method: 'POST',
      path: '/dm/conversations/:id/messages',
      handler: 'api::message.message.send',
      config: DM_AUTH_WRITE,
    },
    {
      method: 'PATCH',
      path: '/dm/messages/:id',
      handler: 'api::message.message.edit',
      config: DM_AUTH_WRITE,
    },
    {
      method: 'DELETE',
      path: '/dm/messages/:id',
      handler: 'api::message.message.withdraw',
      config: DM_AUTH,
    },
  ],
};
