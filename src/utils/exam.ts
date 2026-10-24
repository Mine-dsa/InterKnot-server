import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const configCache = new Map<string, number>();

const loadConfigJson = () => {
  if (configCache.size > 0) return;
  try {
    const p = path.join(process.cwd(), 'data', 'exam_config.json');
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (data) {
        configCache.set('EXAM_PASS_SCORE_PERCENT', Number(data.passScorePercent) || 0);
        configCache.set('EXAM_QUESTION_COUNT', Number(data.questionCount) || 0);
        configCache.set('EXAM_TIME_LIMIT_SECONDS', Number(data.timeLimitSeconds) || 0);
        configCache.set('EXAM_FAIL_COOLDOWN_SECONDS', Number(data.failCooldownSeconds) || 0);
        configCache.set('EXAM_MAX_FAILS_BEFORE_COOLDOWN', Number(data.maxFailsBeforeCooldown) || 0);
        configCache.set('EXAM_REWARD_DENNY', Number(data.rewardDenny) || 0);
        configCache.set('EXAM_REWARD_EXP', Number(data.rewardExp) || 0);
      }
    }
  } catch { /* ignore */ }
};

const getPositiveIntegerEnv = (name: string, fallback: number) => {
  const envVal = Number.parseInt(process.env[name] || '', 10);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  loadConfigJson();
  const fileVal = configCache.get(name);
  if (fileVal && fileVal > 0) return fileVal;
  return fallback;
};

export const EXAM_QUESTION_COUNT = getPositiveIntegerEnv('EXAM_QUESTION_COUNT', 100);
export const EXAM_PASS_SCORE_PERCENT = getPositiveIntegerEnv('EXAM_PASS_SCORE_PERCENT', 90);
export const EXAM_TIME_LIMIT_SECONDS = getPositiveIntegerEnv('EXAM_TIME_LIMIT_SECONDS', 3600);
export const EXAM_MAX_FAILS_BEFORE_COOLDOWN = getPositiveIntegerEnv(
  'EXAM_MAX_FAILS_BEFORE_COOLDOWN',
  3
);
export const EXAM_FAIL_COOLDOWN_SECONDS = getPositiveIntegerEnv(
  'EXAM_FAIL_COOLDOWN_SECONDS',
  30 * 60
);
export const EXAM_REWARD_DENNY = getPositiveIntegerEnv('EXAM_REWARD_DENNY', 50);
export const EXAM_REWARD_EXP = getPositiveIntegerEnv('EXAM_REWARD_EXP', 50);

export type ExamQuestionType = 'single' | 'multiple' | 'boolean';

export type ExamOption = { key: string; text: string };

export type SnapshotQuestion = {
  /** exam-question 的 documentId */
  questionId: string;
  question: string;
  type: ExamQuestionType;
  /** 乱序后的选项 */
  options: ExamOption[];
  /** 正确答案 key（仅存于快照，不下发） */
  correctKeys: string[];
  weight: number;
};

/** 下发给前端的题目（剔除答案） */
export type PublicQuestion = Omit<SnapshotQuestion, 'correctKeys'>;

export const toPublicQuestion = (q: SnapshotQuestion): PublicQuestion => ({
  questionId: q.questionId,
  question: q.question,
  type: q.type,
  options: q.options,
  weight: q.weight,
});

/** Fisher–Yates 乱序（crypto 随机源） */
export const shuffle = <T>(input: readonly T[]): T[] => {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

/** 从题库中随机抽取 count 道题（不足时全取） */
export const sampleQuestions = <T>(pool: readonly T[], count: number): T[] =>
  shuffle(pool).slice(0, Math.min(count, pool.length));

export type ExamAnswers = Record<string, string[] | string | undefined>;

const normalizeAnswer = (raw: string[] | string | undefined): string[] => {
  if (Array.isArray(raw)) return [...new Set(raw.map((k) => String(k)))].sort();
  if (typeof raw === 'string' && raw) return [raw];
  return [];
};

export type GradeResult = {
  score: number;
  totalScore: number;
  scorePercent: number;
  passed: boolean;
  correctCount: number;
  questionCount: number;
};

/**
 * 按快照判分：每题答案 key 集合完全一致才得分（多选不给部分分）。
 */
export const gradeExam = (
  snapshot: readonly SnapshotQuestion[],
  answers: ExamAnswers,
  passScorePercent: number = EXAM_PASS_SCORE_PERCENT
): GradeResult => {
  let score = 0;
  let totalScore = 0;
  let correctCount = 0;

  for (const q of snapshot) {
    const weight = Math.max(1, Number(q.weight) || 1);
    totalScore += weight;
    const expected = [...q.correctKeys].map(String).sort();
    const actual = normalizeAnswer(answers?.[q.questionId]);
    const isCorrect =
      expected.length > 0 &&
      expected.length === actual.length &&
      expected.every((k, i) => k === actual[i]);
    if (isCorrect) {
      score += weight;
      correctCount += 1;
    }
  }

  const scorePercent = totalScore > 0 ? Math.floor((score / totalScore) * 100) : 0;

  return {
    score,
    totalScore,
    scorePercent,
    passed: scorePercent >= passScorePercent,
    correctCount,
    questionCount: snapshot.length,
  };
};
