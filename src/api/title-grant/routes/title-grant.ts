/**
 * title-grant router
 *
 * 授予/撤销/查询记录均走 /management/cosmetics/* 管理端点。
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::title-grant.title-grant', {
  only: [],
});
