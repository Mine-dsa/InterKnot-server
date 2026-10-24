/**
 * cosmetics admin routes（/management/cosmetics/*）
 *
 * 全部走 optional-auth + admin-auth（管理员校验），
 * :kind 为 title | medal，两组资源共用同一套端点。
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
    // 注意：evaluate 无 :kind 参数，必须注册在 :kind 路由之前，避免被其匹配
    adminRoute('POST', '/management/cosmetics/evaluate', 'cosmetics.evaluateAll'),
    adminRoute('GET', '/management/cosmetics/:kind', 'cosmetics.listCosmetics'),
    adminRoute('POST', '/management/cosmetics/:kind', 'cosmetics.createCosmetic'),
    adminRoute('PUT', '/management/cosmetics/:kind/:documentId', 'cosmetics.updateCosmetic'),
    adminRoute('DELETE', '/management/cosmetics/:kind/:documentId', 'cosmetics.deleteCosmetic'),
    adminRoute(
      'POST',
      '/management/cosmetics/:kind/:documentId/grant',
      'cosmetics.grantCosmeticToUser',
    ),
    adminRoute(
      'POST',
      '/management/cosmetics/:kind/:documentId/revoke',
      'cosmetics.revokeCosmeticFromUser',
    ),
    adminRoute('GET', '/management/cosmetics/:kind/grants', 'cosmetics.listGrants'),
  ],
};
