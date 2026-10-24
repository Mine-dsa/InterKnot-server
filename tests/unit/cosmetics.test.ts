import { describe, expect, it } from 'vitest';
import {
  describeCondition,
  evaluateCondition,
  isManualCondition,
  normalizeCondition,
  validateConditionPayload,
  type UserCosmeticsStats,
} from '../../src/utils/cosmetics';

const stats: UserCosmeticsStats = {
  level: 3,
  exp: 2500,
  articleCount: 4,
  commentCount: 30,
  likeReceived: 120,
  checkinConsecutiveDays: 5,
  dennyGiven: 60,
  examPassed: true,
  followerCount: 9,
};

describe('normalizeCondition', () => {
  it('falls back to manual for invalid input', () => {
    expect(normalizeCondition(null)).toEqual({ type: 'manual' });
    expect(normalizeCondition('level')).toEqual({ type: 'manual' });
    expect(normalizeCondition({ type: 'hack' })).toEqual({ type: 'manual' });
    expect(normalizeCondition({ type: 'level', min: -1 })).toEqual({ type: 'manual' });
  });

  it('parses valid atomic conditions', () => {
    expect(normalizeCondition({ type: 'level', min: 3 })).toEqual({ type: 'level', min: 3 });
    expect(normalizeCondition({ type: 'exam_passed' })).toEqual({ type: 'exam_passed' });
    expect(normalizeCondition({ type: 'manual' })).toEqual({ type: 'manual' });
  });

  it('parses all-combinations and drops invalid parts', () => {
    expect(normalizeCondition({ all: [{ type: 'level', min: 2 }, { type: 'bad' }] })).toEqual({
      all: [{ type: 'level', min: 2 }],
    });
    expect(normalizeCondition({ all: [] })).toEqual({ type: 'manual' });
  });
});

describe('evaluateCondition', () => {
  it('evaluates metric conditions', () => {
    expect(evaluateCondition({ type: 'level', min: 3 }, stats)).toBe(true);
    expect(evaluateCondition({ type: 'level', min: 4 }, stats)).toBe(false);
    expect(evaluateCondition({ type: 'like_received', min: 100 }, stats)).toBe(true);
    expect(evaluateCondition({ type: 'follower_count', min: 10 }, stats)).toBe(false);
  });

  it('manual never auto-evaluates; exam_passed mirrors flag', () => {
    expect(evaluateCondition({ type: 'manual' }, stats)).toBe(false);
    expect(evaluateCondition({ type: 'exam_passed' }, stats)).toBe(true);
  });

  it('evaluates AND combinations', () => {
    expect(
      evaluateCondition(
        { all: [{ type: 'level', min: 2 }, { type: 'article_count', min: 5 }] },
        stats,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { all: [{ type: 'level', min: 2 }, { type: 'article_count', min: 4 }] },
        stats,
      ),
    ).toBe(true);
  });
});

describe('isManualCondition', () => {
  it('detects pure manual conditions', () => {
    expect(isManualCondition({ type: 'manual' })).toBe(true);
    expect(isManualCondition({ all: [{ type: 'manual' }] })).toBe(true);
    expect(isManualCondition({ type: 'level', min: 1 })).toBe(false);
    expect(
      isManualCondition({ all: [{ type: 'manual' }, { type: 'exam_passed' }] }),
    ).toBe(false);
  });
});

describe('describeCondition', () => {
  it('renders Chinese descriptions', () => {
    expect(describeCondition({ type: 'manual' })).toBe('仅管理员授予');
    expect(describeCondition({ type: 'level', min: 3 })).toBe('绳网等级 ≥ 3');
    expect(describeCondition({ type: 'exam_passed' })).toBe('通过入站考试');
    expect(
      describeCondition({ all: [{ type: 'level', min: 3 }, { type: 'exp', min: 500 }] }),
    ).toBe('绳网等级 ≥ 3 且 累计绳网信用 ≥ 500');
  });
});

describe('validateConditionPayload', () => {
  it('accepts valid payloads and echoes normalized value', () => {
    const result = validateConditionPayload({ type: 'level', min: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ type: 'level', min: 3 });
  });

  it('rejects invalid payloads with a reason', () => {
    expect(validateConditionPayload({ type: 'nope' }).ok).toBe(false);
    expect(validateConditionPayload({ all: [] }).ok).toBe(false);
    expect(validateConditionPayload({ type: 'level', min: 'abc' }).ok).toBe(false);
  });
});
