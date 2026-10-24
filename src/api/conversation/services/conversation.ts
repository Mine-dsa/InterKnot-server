/**
 * 默认 service：只为 Strapi 内部 factories 生效；业务逻辑全部走 controller，
 * 不通过 service 暴露给前端（避免 admin panel 误用）。
 */
import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::conversation.conversation');
