/**
 * medal router
 *
 * 目录/装备均走 me-medal 自定义端点；管理走 /management/cosmetics/*。
 * Core CRUD 路由不对外暴露。
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::medal.medal', {
  only: [],
});
