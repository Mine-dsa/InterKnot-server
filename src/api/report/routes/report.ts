/**
 * report router —— 仅暴露自定义举报提交端点；不开放 core CRUD。
 * 举报需登录且已通过入站考核（与点赞/评论等写操作一致）。
 */

export default {
  routes: [
    {
      method: 'POST',
      path: '/reports',
      handler: 'report.create',
      config: {
        auth: false,
        policies: [],
        middlewares: ['global::optional-auth', 'global::require-exam-passed'],
      },
    },
  ],
};
