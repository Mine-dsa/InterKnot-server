/**
 * 显式声明 default core router 但不暴露任何 action。
 * 所有 DM 端点都通过 dm-custom.ts 注册——这样 admin panel 仍可对该
 * content-type 做后台管理，但不向 /api/conversations/* 暴露通用 CRUD。
 */
import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::conversation.conversation', {
  only: [],
});
