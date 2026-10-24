/**
 * 自定义分区列表路由：返回已上架频道（供前端 Tab 使用），公开只读。
 */

export default {
  routes: [
    {
      method: 'GET',
      path: '/categories/list',
      handler: 'category.listLite',
      config: {
        auth: false,
        policies: [],
      },
    },
  ],
};
