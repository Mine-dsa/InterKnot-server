import type { Core } from '@strapi/strapi';

/**
 * 等级阈值表
 * Lv.1: 0, Lv.2: 500, Lv.3: 2000, Lv.4: 6000, Lv.5: 15000, Lv.6: 35000, Lv.7: 80000
 * 最高7级封顶
 */
const LEVEL_THRESHOLDS = [0, 500, 2000, 6000, 15000, 35000, 80000] as const;

export const calculateLevel = (exp: number): number => {
  if (exp < 0) return 1;
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (exp >= LEVEL_THRESHOLDS[i]) {
      return i + 1; // 等级从1开始
    }
  }
  return 1;
};

const RECEIVED_INTERACTION_ACTIONS = ['like_received', 'comment_received', 'favorite_received'] as const;
const SELF_INITIATED_DAILY_EXP_CAP = 50;
const RECEIVED_INTERACTION_DAILY_EXP_CAP = 1000;

const getRewardDayWindow = (now = new Date()) => {
  const start = new Date(now);
  start.setHours(4, 0, 0, 0);
  if (now.getHours() < 4) {
    start.setDate(start.getDate() - 1);
  }

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { start, end };
};

/**
 * 给用户加经验（经验日志 + 经验/等级更新，整体在事务内执行）。
 *
 * 事务使用注意（重要）：
 * Strapi 5 的 db.query 会在执行时检查 AsyncLocalStorage 事务上下文
 * （query-builder 的 qb.transacting()），因此**必须**用「有回调」的
 * `strapi.db.transaction(async () => {...})` 形式——回调内的 db.query
 * 会自动走事务连接。无回调形式（`await db.transaction()` 再手动
 * commit/rollback）不会设置事务上下文，事务会占用 knex 的 SQLite
 * 单连接（pool min:1/max:1），内部 db.query 再去池里拿连接就会
 * 自锁死锁（点赞/投币曾因此全局卡死）。
 *
 * @param options.trx 预留：调用方已处于自己的有回调事务中时传入，
 *        本函数直接复用该上下文，不再新开事务。
 */
export const addExp = async (
  strapi: Core.Strapi,
  userId: number,
  amount: number,
  action: string,
  relatedType?: string,
  relatedId?: string | number,
  options?: { trx?: any }
) => {
  const run = async (): Promise<AddExpResult | null> => {
    // 1. 防重复检查 (如果提供了 relatedType 和 relatedId)
    if (relatedType && relatedId) {
      const existingLog = await strapi.db.query('api::experience-log.experience-log').findOne({
        where: {
          user: userId,
          action,
          related_type: relatedType,
          related_id: String(relatedId),
        },
      });

      if (existingLog) {
        strapi.log.info(`Exp log exists for user ${userId}, action ${action}, related ${relatedId}. Skipping.`);
        return null; // 已经加过经验了
      }
    }

    // 2. 获取用户当前经验
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({
      where: { id: userId },
      select: ['exp', 'level', 'examPassed', 'isAiAgent', 'isAdmin'],
    });

    if (!user) {
      return null;
    }

    const currentExp = user.exp || 0;
    const { start, end } = getRewardDayWindow();
    const isReceivedInteraction = (RECEIVED_INTERACTION_ACTIONS as readonly string[]).includes(
      action
    );
    const dailyCap = isReceivedInteraction
      ? RECEIVED_INTERACTION_DAILY_EXP_CAP
      : SELF_INITIATED_DAILY_EXP_CAP;
    const dailyScopeLabel = isReceivedInteraction ? 'received_interaction' : 'self_initiated';
    const todayLogs = await strapi.db.query('api::experience-log.experience-log').findMany({
      where: {
        user: userId,
        createdAt: {
          $gte: start,
          $lt: end,
        },
        action: isReceivedInteraction
          ? { $in: [...RECEIVED_INTERACTION_ACTIONS] }
          : { $notIn: [...RECEIVED_INTERACTION_ACTIONS] },
      },
      select: ['exp'],
    });

    const todayGained = (todayLogs || []).reduce(
      (sum: number, log: any) => sum + (Number(log?.exp) || 0),
      0
    );
    const remaining = Math.max(0, dailyCap - todayGained);
    const grantedAmount = Math.min(Math.max(0, amount), remaining);
    const newExp = currentExp + grantedAmount;

    // 3. 计算新等级（未通过入站考试的普通用户等级锁定为 0）
    const examExempt = user.examPassed || user.isAiAgent || user.isAdmin;
    const newLevel = examExempt ? calculateLevel(newExp) : 0;

    // 4. 记录经验日志 (审计)
    await strapi.db.query('api::experience-log.experience-log').create({
      data: {
        user: userId,
        action,
        exp: grantedAmount,
        related_type: relatedType,
        related_id: String(relatedId),
        description: `Experience change: ${grantedAmount}/${amount} (Total: ${newExp}, Daily ${dailyScopeLabel}: ${todayGained + grantedAmount}/${dailyCap})`,
      },
    });

    // 5. 更新用户 (仅当经验或等级变化时)
    if (newExp !== currentExp || newLevel !== user.level) {
      await strapi.db.query('plugin::users-permissions.user').update({
        where: { id: userId },
        data: {
          exp: newExp,
          level: newLevel,
        },
      });
    }

    return {
      newExp,
      newLevel,
      added: grantedAmount,
      requested: amount,
      capped: grantedAmount < amount,
      dailyGained: todayGained + grantedAmount,
      dailyCap,
      dailyScope: dailyScopeLabel,
    };
  };

  try {
    // 调用方已在其有回调事务中：直接复用上下文
    if (options?.trx) {
      return await run();
    }
    // 有回调事务形式：ALS 传播，run 内的 db.query 自动走事务连接
    return await strapi.db.transaction(async () => {
      return await run();
    });
  } catch (err) {
    strapi.log.error('Error adding exp:', err);
    // 外部事务调用方：向上抛出让调用方回滚整笔操作；否则吞掉避免影响主流程
    if (options?.trx) throw err;
    return null;
  }
};

interface AddExpResult {
  newExp: number;
  newLevel: number;
  added: number;
  requested: number;
  capped: boolean;
  dailyGained: number;
  dailyCap: number;
  dailyScope: string;
}
