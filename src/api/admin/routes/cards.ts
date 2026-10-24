/**
 * 名片管理路由（/management/cards/*）
 * optional-auth + admin-auth（管理员专属），同 cosmetics 模式。
 */

const ADMIN_MIDDLEWARES = ['global::optional-auth', 'global::admin-auth'];

const adminRoute = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [], middlewares: ADMIN_MIDDLEWARES },
});

export default {
  routes: [
    adminRoute('GET', '/management/cards', 'cards.listCards'),
    adminRoute('POST', '/management/cards/upload', 'cards.uploadCard'),
    adminRoute('PUT', '/management/cards/:documentId', 'cards.renameCard'),
    adminRoute('DELETE', '/management/cards/:documentId', 'cards.deleteCard'),
  ],
};
