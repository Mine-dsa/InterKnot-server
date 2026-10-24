import type { LifecycleEvent } from '../../../../types/strapi';
import { extractRelationId } from '../../../../utils/common';

export default {
  async beforeCreate(event: LifecycleEvent) {
    await validateFollowWrite(event);
  },
  async beforeUpdate(event: LifecycleEvent) {
    await validateFollowWrite(event);
  },
};

const loadFollow = async (where: any) =>
  strapi.db.query('api::follow.follow').findOne({
    where,
    populate: {
      follower: { select: ['id'] },
      following: {
        select: ['id'],
        populate: { user: { select: ['id'] } },
      },
    },
  });

async function validateFollowWrite(event: LifecycleEvent) {
  const data = event?.params?.data || {};
  const where = event?.params?.where || {};

  const existing = where?.id
    ? await loadFollow({ id: where.id })
    : null;

  const followerId = extractRelationId(data.follower) || existing?.follower?.id || null;
  const followingId = extractRelationId(data.following) || existing?.following?.id || null;

  if (!followerId) {
    throw new Error('Follow follower is required');
  }
  if (!followingId) {
    throw new Error('Follow following author is required');
  }

  // 禁止关注自己（作者所属用户与关注者相同）。
  const author = await strapi.db.query('api::author.author').findOne({
    where: { id: followingId },
    select: ['id'],
    populate: { user: { select: ['id'] } },
  });
  if (author?.user?.id && author.user.id === followerId) {
    throw new Error('Cannot follow yourself');
  }

  const duplicate = await strapi.db.query('api::follow.follow').findOne({
    where: {
      follower: { id: followerId },
      following: { id: followingId },
    },
    select: ['id'],
  });

  if (duplicate?.id && duplicate.id !== existing?.id) {
    throw new Error('Already following');
  }
}
