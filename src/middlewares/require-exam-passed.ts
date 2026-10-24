import type { Context } from 'koa';
/**
 * require-exam-passed middleware
 *
 * 写操作门控：未通过入站考试的用户禁止发帖、评论、点赞、收藏、
 * 私聊、投币、签到等写操作（只读浏览不受限）。
 *
 * 放行条件：examPassed === true，或 isAdmin / isAiAgent。
 * 做成 route middleware 而非 policy，因为 DM 等路由使用
 * `auth: false` + `global::require-auth`，policy 阶段拿不到 ctx.state.user。
 * 注意必须排在 `global::require-auth` 之后。
 *
 * 每次请求都按 user id 重查 examPassed（主键查询，开销可忽略），
 * 保证用户通过考试后无需重新登录即可立即解锁。
 */
export default (_config: any, { strapi }: any) => {
  return async (ctx: Context, next: () => Promise<void>) => {
    const userId = ctx.state?.user?.id;
    if (!userId) {
      return ctx.unauthorized('authentication required');
    }

    const user = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { id: userId },
      select: ['id', 'examPassed', 'isAdmin', 'isAiAgent'],
    });

    if (user && (user.examPassed || user.isAdmin || user.isAiAgent)) {
      return next();
    }

    ctx.status = 403;
    ctx.body = {
      error: {
        code: 'EXAM_REQUIRED',
        message: '需要先通过入站考试才能进行此操作',
      },
    };
  };
};
