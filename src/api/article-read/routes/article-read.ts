/**
 * article-read router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::article-read.article-read', {
  only: ['create', 'update', 'delete'],
  config: {
    create: {
      policies: ['global::is-user-self'],
    },
    update: {
      policies: ['global::is-user-self'],
    },
    delete: {
      policies: ['global::is-user-self'],
    },
  },
});
