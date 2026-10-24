/**
 * business-card router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::business-card.business-card', {
  only: ['find', 'findOne'],
});
