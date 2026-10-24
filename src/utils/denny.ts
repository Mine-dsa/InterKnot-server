import type { Core } from '@strapi/strapi';
/**
 * 丁尼(Denny)货币系统核心工具函数
 * 参考绝区零(ZZZ)游戏内货币设计
 */

const MAX_DENNY = 9999;

/**
 * 增加用户丁尼
 * @param strapi Strapi实例
 * @param userId 用户ID
 * @param amount 增加数量（必须为正数）
 * @param action 操作类型
 * @param description 描述
 * @param relatedType 关联类型（可选）
 * @param relatedId 关联ID（可选，用于幂等性检查）
 * @returns 操作结果或null（失败），如已存在返回 { existing: true }
 *
 * 事务说明：必须使用「有回调」的 strapi.db.transaction(async () => {...}) 形式——
 * 回调内的 db.query 会通过 AsyncLocalStorage 自动走事务连接。
 * 无回调形式会持有 knex 的 SQLite 单连接（pool min:1/max:1）且不设置
 * 事务上下文，内部 db.query 再去池里拿连接会自锁死锁（60s 全局冻结）。
 */
export const addDenny = async (
  strapi: Core.Strapi,
  userId: number,
  amount: number,
  action: string,
  description?: string,
  relatedType?: string,
  relatedId?: string | number,
) => {
  if (amount <= 0) {
    strapi.log.warn(`[denny] Invalid amount: ${amount}, must be positive`);
    return null;
  }

  // 参数校验和清理
  const cleanRelatedId = relatedId ? String(relatedId).substring(0, 255) : undefined;
  const cleanDescription = description ? description.substring(0, 255) : undefined;

  const run = async (): Promise<
    | null
    | { existing: true; newBalance: number; added: 0; requested: number; capped: boolean }
    | { newBalance: number; added: number; requested: number; capped: boolean }
  > => {
    // 获取用户当前丁尼
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { id: userId },
      select: ['denny', 'denny_given'],
    });

    if (!user) {
      strapi.log.error(`[denny] User not found: ${userId}`);
      return null;
    }

    // 幂等性检查：如果提供了 relatedType 和 relatedId，检查是否已存在
    if (relatedType && cleanRelatedId) {
      const existingLog = await strapi.db.query('api::denny-log.denny-log').findOne({
        where: {
          user: userId,
          action,
          related_type: relatedType,
          related_id: cleanRelatedId,
        },
        select: ['id'],
      });

      if (existingLog) {
        strapi.log.info(
          `[denny] Log exists for user ${userId}, action ${action}, related ${cleanRelatedId}. Skipping.`,
        );
        return {
          existing: true as const,
          newBalance: user?.denny || 0,
          added: 0,
          requested: amount,
          capped: false,
        };
      }
    }

    const currentDenny = Math.min(user.denny || 0, MAX_DENNY);
    // 封顶处理：超过9999的部分直接丢弃
    const newDenny = Math.min(currentDenny + amount, MAX_DENNY);
    const actualAdded = newDenny - currentDenny;

    if (actualAdded <= 0) {
      // 已达上限，记录日志但返回特殊标记
      strapi.log.info(`[denny] User ${userId} reached cap ${MAX_DENNY}, skipped ${amount}`);
    }

    // 记录丁尼日志（使用清理后的参数）
    await strapi.db.query('api::denny-log.denny-log').create({
      data: {
        user: userId,
        action,
        amount: actualAdded,
        balance: newDenny,
        related_type: relatedType,
        related_id: cleanRelatedId || '',
        description: cleanDescription || `Denny +${actualAdded} (capped from ${amount})`,
      },
    });

    // 更新用户丁尼（仅当有实际变动时）
    if (actualAdded > 0) {
      await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: userId },
        data: { denny: newDenny },
      });
    }

    return {
      newBalance: newDenny,
      added: actualAdded,
      requested: amount,
      capped: actualAdded < amount,
    };
  };

  try {
    // 有回调事务：ALS 传播，run 内的 db.query 自动走事务连接
    return await strapi.db.transaction(async () => {
      return await run();
    });
  } catch (err) {
    strapi.log.error('[denny] Error adding denny:', err);
    return null;
  }
};

/**
 * 扣除用户丁尼（使用原子操作避免竞态条件）
 * @param strapi Strapi实例
 * @param userId 用户ID
 * @param amount 扣除数量（必须为正数）
 * @param action 操作类型
 * @param description 描述
 * @param relatedType 关联类型（可选）
 * @param relatedId 关联ID（可选）
 * @returns 操作结果或null（余额不足或失败）
 */
export const deductDenny = async (
  strapi: Core.Strapi,
  userId: number,
  amount: number,
  action: string,
  description?: string,
  relatedType?: string,
  relatedId?: string | number
) => {
  if (amount <= 0) {
    strapi.log.warn(`[denny] Invalid deduct amount: ${amount}, must be positive`);
    return null;
  }

  try {
    // 参数校验和清理
    const cleanRelatedId = relatedId ? String(relatedId).substring(0, 255) : undefined;
    const cleanDescription = description ? description.substring(0, 255) : undefined;

    // 使用原子SQL操作：UPDATE ... SET denny = denny - amount WHERE id = ? AND denny >= amount
    // 这避免了查询-检查-更新的竞态条件
    const knex = strapi.db.connection;
    // Strapi v5 没有 db.getModel，直接使用 schema 中定义的 collectionName
    const USER_TABLE = 'up_users';

    // 原子扣款：只有当余额充足时才扣款
    const updateResult = await knex(USER_TABLE)
      .where({ id: userId })
      .andWhere('denny', '>=', amount)
      .decrement('denny', amount);

    // updateResult 是受影响的行数
    if (updateResult === 0) {
      // 扣款失败，可能是余额不足或用户不存在
      const user = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: userId },
        select: ['denny'],
      });

      if (!user) {
        strapi.log.error(`[denny] User not found: ${userId}`);
        return null;
      }

      return {
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: `Insufficient Denny balance: ${user.denny || 0} < ${amount}`,
        currentBalance: user.denny || 0,
      };
    }

    // 获取更新后的余额
    const updatedUser = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { id: userId },
      select: ['denny'],
    });

    const newDenny = updatedUser?.denny || 0;

    // 记录丁尼日志（异步，失败不影响主流程）
    try {
      await strapi.db.query('api::denny-log.denny-log').create({
        data: {
          user: userId,
          action,
          amount: -amount,
          balance: newDenny,
          related_type: relatedType,
          related_id: cleanRelatedId || '',
          description: cleanDescription || `Denny -${amount}`,
        },
      });
    } catch (logErr) {
      strapi.log.warn('[denny] Failed to create deduct log:', logErr);
    }

    return {
      success: true,
      newBalance: newDenny,
      deducted: amount,
    };
  } catch (err) {
    strapi.log.error('[denny] Error deducting denny:', err);
    return null;
  }
};

/**
 * 获取用户丁尼余额
 * @param strapi Strapi实例
 * @param userId 用户ID
 * @returns 余额或null（用户不存在）
 */
export const getDennyBalance = async (strapi: Core.Strapi, userId: number) => {
  try {
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { id: userId },
      select: ['denny', 'denny_given'],
    });

    if (!user) return null;

    return {
      denny: user.denny || 0,
      dennyGiven: user.denny_given || 0,
    };
  } catch (err) {
    strapi.log.error('[denny] Error getting balance:', err);
    return null;
  }
};

/**
 * 给帖子投币（使用事务确保原子性）
 * @param strapi Strapi实例
 * @param userId 用户ID
 * @param articleId 帖子ID（documentId）
 * @param message 留言（可选）
 * @returns 操作结果
 */
export const giveDennyToArticle = async (
  strapi: Core.Strapi,
  userId: number,
  articleId: string,
  message?: string
) => {
  const GIVE_COST = 1;
  let tipRatio = 1;
  try {
    const r = await strapi.db.connection('strapi_core_store_settings').select('value').where({ key: 'tip_ratio' }).first();
    if (r) { const v = JSON.parse(r.value); tipRatio = parseInt(v.ratio) || 1; }
  } catch { /* noop */ }

  const knex = strapi.db.connection;

  const article = await strapi.db.query('api::article.article').findOne({
    where: { documentId: articleId, publishedAt: { $notNull: true } },
    select: ['id', 'documentId', 'isAnonymous', 'denny_count'],
    populate: { author: { select: ['id', 'documentId'] } },
  });
  if (!article) return { success: false, error: 'ARTICLE_NOT_FOUND', message: 'Article not found' };
  if (article.isAnonymous) return { success: false, error: 'ANONYMOUS_ARTICLE', message: 'Cannot give Denny to anonymous article' };

  const authorRow = await strapi.db.query('api::author.author').findOne({
    where: { id: article.author?.id },
    populate: { user: { select: ['id'] } },
  });
  const authorUserId = authorRow?.user?.id;
  if (!authorUserId || authorUserId === userId) return { success: false, error: 'SELF_GIVE', message: 'Cannot give Denny to your own article' };

  const existingGiven = await strapi.db.query('api::denny-given.denny-given').findOne({
    where: { user: userId, article: article.id },
  });
  if (existingGiven) return { success: false, error: 'ALREADY_GIVEN', message: 'Already given Denny to this article' };

  // 原子扣减（含 denny_given 累计）：UPDATE up_users SET denny = denny - 1, denny_given = denny_given + 1
  // WHERE id = ? AND denny >= 1 —— 替代原「读-改-写」，关闭并发双击时的双扣/丢更新窗口。
  const deducted = await knex('up_users')
    .where({ id: userId })
    .andWhere('denny', '>=', GIVE_COST)
    .update({
      denny: knex.raw('?? - ??', ['denny', GIVE_COST]),
      denny_given: knex.raw('?? + ??', ['denny_given', GIVE_COST]),
    });

  if (deducted === 0) {
    const user = await knex('up_users').where({ id: userId }).select('denny').first();
    if (!user) return { success: false, error: 'USER_NOT_FOUND', message: 'User not found' };
    return {
      success: false,
      error: 'INSUFFICIENT_BALANCE',
      message: `Insufficient Denny balance`,
      currentBalance: user.denny || 0,
    };
  }

  const afterDeduct = await knex('up_users').where({ id: userId }).select('denny').first();
  const newUserDenny = afterDeduct?.denny ?? 0;

  // 防重复投币（并发 TOCTOU 兜底）：existence 预检查存在窗口期，这里在插入后
  // 复核 (user, article) 计数——若发现自己不是最早一笔（并发双击同时通过预检查），
  // 回滚本次：删除本行并全额退还。
  const givenRow = await strapi.db.query('api::denny-given.denny-given').create({
    data: { user: userId, article: article.id, amount: GIVE_COST, message: message?.substring(0, 100) || null },
  });
  try {
    const dupCount = await strapi.db.query('api::denny-given.denny-given').count({
      where: { user: userId, article: article.id },
    });
    if (dupCount > 1 && givenRow?.id) {
      const earliest = await strapi.db.query('api::denny-given.denny-given').findOne({
        where: { user: userId, article: article.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: ['id'],
      });
      if (earliest?.id && earliest.id !== givenRow.id) {
        // 并发窗口内的重复投币：撤销本次（删行 + 退还）
        await strapi.db.query('api::denny-given.denny-given').delete({ where: { id: givenRow.id } });
        await knex('up_users')
          .where({ id: userId })
          .update({
            denny: knex.raw('?? + ??', ['denny', GIVE_COST]),
            denny_given: knex.raw('?? - ??', ['denny_given', GIVE_COST]),
          });
        return { success: false, error: 'ALREADY_GIVEN', message: 'Already given Denny to this article' };
      }
    }
  } catch (err) {
    strapi.log.warn(`[denny] duplicate-give recheck failed for user ${userId} article ${article.id}: ${err}`);
  }

  await knex('articles').where({ id: article.id }).increment('denny_count', 1);

  // 作者收益原子入账（不封顶逻辑保持不变：管理员设定的比例即规则）。
  // 跨方言封顶写法：LEAST() 是 MySQL 函数（SQLite 无），MIN() 多参是 SQLite
  // 语义（MySQL 中 MIN 是聚合函数）——用 CASE WHEN 两边方言行为一致。
  const authorRecv = tipRatio;
  if (authorRecv > 0) {
    await knex('up_users')
      .where({ id: authorUserId })
      .update({
        denny: knex.raw(
          'CASE WHEN ?? + ? > ? THEN ? ELSE ?? + ? END',
          ['denny', authorRecv, 99999999, 99999999, 'denny', authorRecv]
        ),
      });
  }

  try {
    await strapi.db.query('api::notification.notification').create({
      data: { type: 'denny', recipient: authorUserId, sender: userId, Article: article.id, isRead: false },
    });
  } catch { /* noop */ }

  try {
    await strapi.db.query('api::denny-log.denny-log').create({
      data: { user: userId, action: 'give_post', amount: -GIVE_COST, balance: newUserDenny, related_type: 'api::article.article', related_id: String(articleId).substring(0, 255), description: `投币给帖子` },
    });
  } catch { /* noop */ }

  return { success: true, newBalance: newUserDenny, articleDennyCount: (article.denny_count || 0) + 1 };
};
