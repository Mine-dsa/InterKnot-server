import { getDennyBalance, giveDennyToArticle } from '../../../utils/denny';

/**
 * 用户丁尼 API 控制器
 * 安全说明：deduct 功能仅限内部使用，不暴露公共接口
 */
export default {
  /**
   * 获取当前用户的丁尼余额和日志
   * GET /api/user-denny
   */
  async getBalance(ctx) {
    const user = ctx.state.user;

    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const balance = await getDennyBalance(strapi, user.id);

    if (!balance) {
      ctx.status = 500;
      ctx.body = {
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch Denny balance.',
        },
      };
      return;
    }

    // 获取最近10条丁尼日志
    const logs = await strapi.db.query('api::denny-log.denny-log').findMany({
      where: { user: user.id },
      orderBy: { createdAt: 'desc' },
      limit: 10,
      select: ['action', 'amount', 'balance', 'description', 'createdAt'],
    });

    return ctx.send({
      denny: balance.denny,
      dennyGiven: balance.dennyGiven,
      recentLogs: logs || [],
    });
  },

  /**
   * 给帖子投币
   * POST /api/user-denny/give
   * Body: { articleId: string, message?: string }
   * 安全：message 字段会自动过滤 XSS 风险字符
   */
  async giveToArticle(ctx) {
    const user = ctx.state.user;

    if (!user?.id) {
      return ctx.unauthorized('You must be logged in.');
    }

    const { articleId, message } = ctx.request.body || {};

    if (!articleId || typeof articleId !== 'string' || articleId.length > 100) {
      ctx.status = 400;
      ctx.body = {
        error: {
          code: 'INVALID_PARAMS',
          message: 'articleId is required and must be a valid string.',
        },
      };
      return;
    }

    // XSS 防护：过滤 message 中的危险字符
    const sanitizedMessage = message && typeof message === 'string'
      ? message.substring(0, 100).replace(/[<>"'&]/g, '')
      : undefined;

    const result = await giveDennyToArticle(strapi, user.id, articleId, sanitizedMessage);

    if (!result.success) {
      const statusMap: Record<string, number> = {
        ARTICLE_NOT_FOUND: 404,
        ANONYMOUS_ARTICLE: 403,
        SELF_GIVE: 403,
        ALREADY_GIVEN: 409,
        INSUFFICIENT_BALANCE: 402,
        DEDUCT_FAILED: 500,
        INTERNAL_ERROR: 500,
      };

      ctx.status = statusMap[result.error] || 400;
      // 修复：不返回完整 result 对象，避免信息泄露
      ctx.body = {
        error: {
          code: result.error,
          message: result.message,
        },
      };
      return;
    }

    return ctx.send({
      success: true,
      message: 'Successfully given 1 Denny to the article.',
      newBalance: (result).newBalance,
      articleDennyCount: (result).articleDennyCount,
    });
  },
};
