/**
 * 作者搜索路由：评论编辑器里 @ 触发的自动补全用。
 *
 * `auth: {}` —— 必须登录。这是一个面向「正在写评论」的内嵌交互，
 * 公开开放反而容易被爬作者列表用作业务情报。
 */
export default {
  routes: [
    {
      method: 'GET',
      path: '/authors/search',
      handler: 'author.search',
      config: {
        auth: {},
        policies: [],
      },
    },
  ],
};
