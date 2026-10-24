/**
 * 不暴露任何默认 CRUD 路由。所有 message 端点由 conversation/routes/dm-custom.ts
 * 集中注册（/dm/messages/*, /dm/conversations/:id/messages）。
 */
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::message.message', {
  only: [],
});
