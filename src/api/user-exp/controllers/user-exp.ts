import { formatLocalDate } from '../../../utils/common';

export default {
  async get(ctx) {
    const user = ctx.state?.user;

    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const record = await strapi.db
      .query('plugin::users-permissions.user')
      .findOne({
        where: { id: user.id },
        select: ['exp', 'level', 'lastCheckInDate', 'consecutiveCheckInDays'],
      });

    if (!record) {
      ctx.status = 404;
      ctx.body = {
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User not found.',
        },
      };
      return;
    }

    const lastCheckInDate = record.lastCheckInDate
      ? formatLocalDate(new Date(record.lastCheckInDate))
      : null;

    const now = new Date();
    const checkInDay = new Date(now);
    if (checkInDay.getHours() < 4) {
      checkInDay.setDate(checkInDay.getDate() - 1);
    }
    const today = formatLocalDate(checkInDay);
    const canCheckIn = lastCheckInDate !== today;

    const checkInDayStart = new Date(now);
    checkInDayStart.setHours(4, 0, 0, 0);
    if (now.getHours() < 4) {
      checkInDayStart.setDate(checkInDayStart.getDate() - 1);
    }
    const nextEligibleAt = new Date(checkInDayStart);
    nextEligibleAt.setDate(checkInDayStart.getDate() + 1);

    return ctx.send({
      exp: record.exp ?? 0,
      level: record.level ?? 1,
      lastCheckInDate,
      consecutiveCheckInDays: record.consecutiveCheckInDays ?? 0,
      canCheckIn,
      ...(canCheckIn ? {} : { nextEligibleAt: nextEligibleAt.toISOString() }),
    });
  },
};
