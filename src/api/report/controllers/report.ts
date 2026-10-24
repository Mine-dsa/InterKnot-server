/**
 * report controller —— 用户举报提交（文章 / 评论 / 用户）。
 *
 * 仅暴露一个自定义写端点 POST /api/reports（前端 ReportModal 调用）。
 * 记录举报类型、理由、举报者，并尽量关联被举报对象（文章/评论/被举报用户），
 * 供管理后台审核与处置（删除内容 / 删除记录）。
 */
const REPORT_UID = 'api::report.report';
const ARTICLE_UID = 'api::article.article';
const COMMENT_UID = 'api::comment.comment';
const USER_UID = 'plugin::users-permissions.user';

const TARGET_TYPES = new Set(['article', 'comment', 'user']);
const REASONS = new Set([
  'spam',
  'abuse',
  'porn',
  'illegal',
  'privacy',
  'misinfo',
  'plagiarism',
  'other',
]);
const MAX_DETAIL = 500;
const MAX_TARGET_ID = 64;

export default {
  async create(ctx: any) {
    const user = ctx.state?.user;
    if (!user?.id) return ctx.unauthorized('You must be logged in.');

    // 兼容 { data: {...} } 与直接平铺两种请求体
    const body = ctx.request?.body?.data || ctx.request?.body || {};
    const targetType = typeof body.targetType === 'string' ? body.targetType.trim() : '';
    const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const detailRaw = typeof body.detail === 'string' ? body.detail.trim() : '';

    if (!TARGET_TYPES.has(targetType)) return ctx.badRequest('Invalid targetType');
    if (!targetId || targetId.length > MAX_TARGET_ID) return ctx.badRequest('Invalid targetId');
    if (!REASONS.has(reason)) return ctx.badRequest('Invalid reason');
    if (detailRaw.length > MAX_DETAIL) return ctx.badRequest('detail is too long');

    // 解析被举报对象（尽力而为：对象已不存在时仍记录举报，便于追溯异常）
    let articleId: number | null = null;
    let commentId: number | null = null;
    let targetUserId: number | null = null;

    try {
      if (targetType === 'article') {
        const article = await strapi.db.query(ARTICLE_UID).findOne({
          where: { documentId: targetId },
          select: ['id'],
        });
        articleId = article?.id ?? null;
      } else if (targetType === 'comment') {
        const comment = await strapi.db.query(COMMENT_UID).findOne({
          where: { documentId: targetId },
          select: ['id'],
          populate: { article: { select: ['id'] } },
        });
        commentId = comment?.id ?? null;
        articleId = comment?.article?.id ?? null;
      } else if (targetType === 'user') {
        const uid = Number.parseInt(targetId, 10);
        if (Number.isInteger(uid) && uid > 0) {
          const target = await strapi.db.query(USER_UID).findOne({
            where: { id: uid },
            select: ['id'],
          });
          targetUserId = target?.id ?? null;
        }
      }
    } catch (err) {
      strapi.log.warn(`[report] resolve target failed (${targetType}:${targetId}): ${err}`);
    }

    try {
      const report = await strapi.db.query(REPORT_UID).create({
        data: {
          targetType,
          targetId,
          reason,
          detail: detailRaw || null,
          reporter: user.id,
          article: articleId,
          comment: commentId,
          targetUser: targetUserId,
        },
      });

      strapi.log.info(
        `[report] user ${user.id} reported ${targetType}:${targetId} reason=${reason}`,
      );
      ctx.status = 201;
      ctx.send({ data: { documentId: report.documentId } });
    } catch (err) {
      strapi.log.error(`[report] create failed: ${err}`);
      return ctx.internalServerError('举报提交失败，请稍后再试');
    }
  },
};
