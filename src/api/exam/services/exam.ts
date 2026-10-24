import type { Core } from '@strapi/strapi';
import {
  EXAM_FAIL_COOLDOWN_SECONDS,
  EXAM_MAX_FAILS_BEFORE_COOLDOWN,
  EXAM_PASS_SCORE_PERCENT,
  EXAM_QUESTION_COUNT,
  EXAM_REWARD_DENNY,
  EXAM_REWARD_EXP,
  EXAM_TIME_LIMIT_SECONDS,
  gradeExam,
  sampleQuestions,
  shuffle,
  toPublicQuestion,
  type ExamAnswers,
  type ExamOption,
  type SnapshotQuestion,
} from '../../../utils/exam';
import { calculateLevel } from '../../../utils/level';

const USER_UID = 'plugin::users-permissions.user';
const QUESTION_UID = 'api::exam-question.exam-question';
const ATTEMPT_UID = 'api::exam-attempt.exam-attempt';

type FlowError = Error & {
  status?: number;
  statusCode?: number;
  code?: string;
  details?: Record<string, unknown>;
};

function createFlowError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): FlowError {
  const error = new Error(message) as FlowError;
  error.status = status;
  error.statusCode = status;
  error.code = code;
  error.details = details;
  return error;
}

const examConfig = () => ({
  questionCount: EXAM_QUESTION_COUNT,
  passScorePercent: EXAM_PASS_SCORE_PERCENT,
  timeLimitSeconds: EXAM_TIME_LIMIT_SECONDS,
  maxFailsBeforeCooldown: EXAM_MAX_FAILS_BEFORE_COOLDOWN,
  failCooldownSeconds: EXAM_FAIL_COOLDOWN_SECONDS,
  rewardDenny: EXAM_REWARD_DENNY,
  rewardExp: EXAM_REWARD_EXP,
});

const normalizeOptions = (raw: unknown): ExamOption[] | null => {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { return null } }
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const options: ExamOption[] = [];
  for (const item of arr) {
    const key = typeof item?.key === 'string' ? item.key : '';
    const text = typeof item?.text === 'string' ? item.text : '';
    if (!key || !text) return null;
    options.push({ key, text });
  }
  return options;
};

const normalizeCorrectKeys = (raw: unknown, options: ExamOption[]): string[] | null => {
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch { return null } }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const optionKeys = new Set(options.map((o) => o.key));
  const keys = [...new Set(arr.map((k: unknown) => String(k)))];
  if (!keys.every((k) => optionKeys.has(k))) return null;
  return keys;
};

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  /** 距离冷却结束的秒数；0 表示不在冷却期 */
  async getCooldownRemaining(userId: number): Promise<number> {
    const recent = await strapi.db.query(ATTEMPT_UID).findMany({
      where: { user: userId, submittedAt: { $notNull: true } },
      orderBy: { submittedAt: 'desc' },
      limit: EXAM_MAX_FAILS_BEFORE_COOLDOWN,
      select: ['id', 'passed', 'submittedAt'],
    });

    if (recent.length < EXAM_MAX_FAILS_BEFORE_COOLDOWN) return 0;
    if (recent.some((a: any) => a.passed)) return 0;

    const lastFailAt = new Date(recent[0].submittedAt).getTime();
    const cooldownUntil = lastFailAt + EXAM_FAIL_COOLDOWN_SECONDS * 1000;
    return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  },

  async findActiveAttempt(userId: number) {
    return strapi.db.query(ATTEMPT_UID).findOne({
      where: {
        user: userId,
        submittedAt: { $null: true },
        expiresAt: { $gt: new Date() },
      },
      orderBy: { startedAt: 'desc' },
    });
  },

  async getStatus(userId: number) {
    const user = await strapi.db.query(USER_UID).findOne({
      where: { id: userId },
      select: ['id', 'examPassed', 'examPassedAt'],
    });
    if (!user) throw createFlowError(404, 'USER_NOT_FOUND', '用户不存在');

    if (user.examPassed) {
      return { passed: true, passedAt: user.examPassedAt || null, config: examConfig() };
    }

    const [active, cooldownRemaining] = await Promise.all([
      this.findActiveAttempt(userId),
      this.getCooldownRemaining(userId),
    ]);

    return {
      passed: false,
      passedAt: null,
      cooldownRemaining,
      activeAttempt: active
        ? {
            attemptId: active.documentId,
            startedAt: active.startedAt,
            expiresAt: active.expiresAt,
            questionCount: Array.isArray(active.questionsSnapshot)
              ? active.questionsSnapshot.length
              : 0,
          }
        : null,
      config: examConfig(),
    };
  },

  async startExam(userId: number, requestIp?: string) {
    const user = await strapi.db.query(USER_UID).findOne({
      where: { id: userId },
      select: ['id', 'examPassed'],
    });
    if (!user) throw createFlowError(404, 'USER_NOT_FOUND', '用户不存在');
    if (user.examPassed) {
      throw createFlowError(400, 'EXAM_ALREADY_PASSED', '你已通过入站考试');
    }

    const cooldownRemaining = await this.getCooldownRemaining(userId);
    if (cooldownRemaining > 0) {
      throw createFlowError(429, 'EXAM_COOLDOWN', '考试失败次数过多，请稍后再试', {
        retryAfter: cooldownRemaining,
      });
    }

    // 已有进行中的考试则直接恢复，避免反复刷题换题
    const active = await this.findActiveAttempt(userId);
    if (active) {
      const snapshot = (active.questionsSnapshot || []) as SnapshotQuestion[];
      return {
        attemptId: active.documentId,
        resumed: true,
        startedAt: active.startedAt,
        expiresAt: active.expiresAt,
        questions: snapshot.map(toPublicQuestion),
        config: examConfig(),
      };
    }

    const pool = await strapi.db.query(QUESTION_UID).findMany({
      where: { enabled: true },
      select: ['id', 'documentId', 'question', 'type', 'options', 'correctKeys', 'weight'],
    });

    const validQuestions: SnapshotQuestion[] = [];
    for (const q of pool) {
      const options = normalizeOptions(q.options);
      if (!options) continue;
      const correctKeys = normalizeCorrectKeys(q.correctKeys, options);
      if (!correctKeys) continue;
      validQuestions.push({
        questionId: q.documentId,
        question: q.question,
        type: q.type,
        options,
        correctKeys,
        weight: Math.max(1, Number(q.weight) || 1),
      });
    }

    if (validQuestions.length === 0) {
      throw createFlowError(503, 'EXAM_NOT_AVAILABLE', '题库暂未配置，请稍后再试');
    }

    const snapshot = sampleQuestions(validQuestions, EXAM_QUESTION_COUNT).map((q) => ({
      ...q,
      options: shuffle(q.options),
    }));

    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXAM_TIME_LIMIT_SECONDS * 1000);

    const attempt = await strapi.db.query(ATTEMPT_UID).create({
      data: {
        user: userId,
        questionsSnapshot: snapshot,
        startedAt: now,
        expiresAt,
        requestIp: requestIp || null,
      },
    });

    return {
      attemptId: attempt.documentId,
      resumed: false,
      startedAt: attempt.startedAt,
      expiresAt: attempt.expiresAt,
      questions: snapshot.map(toPublicQuestion),
      config: examConfig(),
    };
  },

  async submitExam(userId: number, body: any) {
    const attemptId = typeof body?.attemptId === 'string' ? body.attemptId : '';
    const answers = (body?.answers && typeof body.answers === 'object' ? body.answers : {}) as ExamAnswers;
    if (!attemptId) {
      throw createFlowError(400, 'EXAM_ATTEMPT_ID_REQUIRED', '缺少考试场次标识');
    }

    const attempt = await strapi.db.query(ATTEMPT_UID).findOne({
      where: { documentId: attemptId, user: userId },
    });
    if (!attempt) {
      throw createFlowError(400, 'EXAM_ATTEMPT_NOT_FOUND', '考试场次不存在');
    }
    if (attempt.submittedAt) {
      throw createFlowError(400, 'EXAM_ATTEMPT_ALREADY_SUBMITTED', '本场考试已提交');
    }

    const now = new Date();
    if (!attempt.expiresAt || new Date(attempt.expiresAt).getTime() <= now.getTime()) {
      await strapi.db.query(ATTEMPT_UID).update({
        where: { id: attempt.id },
        data: { submittedAt: now, passed: false, answers, score: 0, scorePercent: 0 },
      });
      throw createFlowError(400, 'EXAM_ATTEMPT_EXPIRED', '考试已超时，请重新开始');
    }

    const snapshot = (attempt.questionsSnapshot || []) as SnapshotQuestion[];
    const result = gradeExam(snapshot, answers);

    // 条件更新作为原子闸门：仅当尚未提交时才写入成绩。
    // 并发双提交时只有一方能命中（update 找不到记录返回 null），
    // 杜绝双份 submittedAt / 双份发奖。
    const claimed = await strapi.db.query(ATTEMPT_UID).update({
      where: { id: attempt.id, submittedAt: { $null: true } },
      data: {
        answers,
        submittedAt: now,
        score: result.score,
        totalScore: result.totalScore,
        scorePercent: result.scorePercent,
        passed: result.passed,
      },
    });
    if (!claimed) {
      throw createFlowError(400, 'EXAM_ATTEMPT_ALREADY_SUBMITTED', '本场考试已提交');
    }

    if (result.passed) {
      const user = await strapi.db.query(USER_UID).findOne({
        where: { id: userId },
        select: ['id', 'exp', 'examPassed'],
      });

      if (user && !user.examPassed) {
        // 条件更新抢占发奖权：仅当尚未通过时才置为已通过。
        // 并发多场考试同时通过时只有一方能进入发奖段（返回 null 即已被抢占）。
        const claimedPass = await strapi.db.query(USER_UID).update({
          where: { id: userId, examPassed: false },
          data: {
            examPassed: true,
            examPassedAt: now,
            level: Math.max(1, calculateLevel(user.exp || 0)),
          },
        });
        if (!claimedPass) {
          strapi.log.info(`[exam] user ${userId} already rewarded by a concurrent attempt, skip`);
        } else {
          // 奖励为非关键路径：失败不阻塞通过结果。
          try {
            if (EXAM_REWARD_DENNY > 0) {
              const dennyUser = await strapi.db.query(USER_UID).findOne({
                where: { id: userId }, select: ['denny'],
              });
              if (dennyUser) {
                const newDenny = Math.min(9999, (dennyUser.denny || 0) + EXAM_REWARD_DENNY);
                await strapi.db.query(USER_UID).update({
                  where: { id: userId },
                  data: { denny: newDenny },
                });
                await strapi.db.query('api::denny-log.denny-log').create({
                  data: { user: userId, action: 'exam_passed', amount: EXAM_REWARD_DENNY, balance: newDenny, description: '通过入站考试奖励' },
                }).catch(() => {});
              }
            }
            if (EXAM_REWARD_EXP > 0) {
              const expUser = await strapi.db.query(USER_UID).findOne({
                where: { id: userId }, select: ['exp', 'level'],
              });
              if (expUser) {
                const newExp = (expUser.exp || 0) + EXAM_REWARD_EXP;
                const newLevel = calculateLevel(newExp);
                await strapi.db.query(USER_UID).update({
                  where: { id: userId },
                  data: { exp: newExp, level: newLevel },
                });
                await strapi.db.query('api::experience-log.experience-log').create({
                  data: { user: userId, action: 'exam_passed', amount: EXAM_REWARD_EXP, exp: newExp, level: newLevel },
                }).catch(() => {});
              }
            }
          } catch (err) {
            strapi.log.error(`[exam] reward failed for user ${userId}: ${err}`);
          }
        }
      }
    }

    const cooldownRemaining = result.passed ? 0 : await this.getCooldownRemaining(userId);

    return {
      passed: result.passed,
      score: result.score,
      totalScore: result.totalScore,
      scorePercent: result.scorePercent,
      correctCount: result.correctCount,
      questionCount: result.questionCount,
      passScorePercent: EXAM_PASS_SCORE_PERCENT,
      cooldownRemaining,
      reward: result.passed ? { denny: EXAM_REWARD_DENNY, exp: EXAM_REWARD_EXP } : null,
    };
  },
});
