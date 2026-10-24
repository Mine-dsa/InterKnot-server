/**
 * 不暴露任何默认 CRUD 路由。conversation-member 仅作为内部中间表使用，
 * 写入由 conversation controller 控制；读取由 detail / list 接口聚合返回。
 */
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::conversation-member.conversation-member', {
  only: [],
});
