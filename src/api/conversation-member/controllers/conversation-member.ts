/**
 * 占位 controller：不暴露任何 action（routes only:[]）。
 * 业务逻辑全部在 conversation controller 与 message controller 中处理；
 * 这里仅满足 Strapi factories.createCoreRouter 的 controller 存在性要求。
 */
import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::conversation-member.conversation-member');
