/**
 * favorite router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::favorite.favorite', {
  only: ['create', 'update', 'delete'],
  config: {
    create: {
      policies: ['global::is-favorite-owner'],
      middlewares: ['global::require-exam-passed'],
    },
    update: {
      policies: ['global::is-favorite-owner'],
      middlewares: ['global::require-exam-passed'],
    },
    delete: {
      policies: ['global::is-favorite-owner'],
      middlewares: ['global::require-exam-passed'],
    },
  },
});
