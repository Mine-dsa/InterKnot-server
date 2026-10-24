/**
 * article router.
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::article.article', {
  only: ['create', 'update'],
  config: {
    create: {
      policies: ['global::is-author-self'],
      middlewares: ['global::require-exam-passed'],
    },
    update: {
      policies: ['global::is-owner'],
      middlewares: ['global::require-exam-passed'],
    },
  },
});
