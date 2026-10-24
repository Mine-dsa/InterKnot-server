/**
 * comment router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::comment.comment', {
  only: ['create', 'delete'],
  config: {
    create: {
      policies: [],
      middlewares: ['global::require-exam-passed'],
    },
    delete: {
      policies: ['global::is-comment-author'],
    },
  },
});
