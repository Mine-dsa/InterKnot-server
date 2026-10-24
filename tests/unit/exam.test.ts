import { describe, expect, it } from 'vitest';
import {
  gradeExam,
  sampleQuestions,
  shuffle,
  toPublicQuestion,
  type SnapshotQuestion,
} from '../../src/utils/exam';

const q = (
  id: string,
  correctKeys: string[],
  weight = 1,
  type: SnapshotQuestion['type'] = 'single'
): SnapshotQuestion => ({
  questionId: id,
  question: `question ${id}`,
  type,
  options: [
    { key: 'a', text: 'A' },
    { key: 'b', text: 'B' },
    { key: 'c', text: 'C' },
    { key: 'd', text: 'D' },
  ],
  correctKeys,
  weight,
});

describe('gradeExam', () => {
  it('passes when all answers are correct', () => {
    const snapshot = [q('q1', ['a']), q('q2', ['b']), q('q3', ['c', 'd'], 1, 'multiple')];
    const result = gradeExam(snapshot, { q1: ['a'], q2: 'b', q3: ['d', 'c'] }, 90);
    expect(result.score).toBe(3);
    expect(result.totalScore).toBe(3);
    expect(result.scorePercent).toBe(100);
    expect(result.passed).toBe(true);
    expect(result.correctCount).toBe(3);
  });

  it('fails below the pass threshold', () => {
    const snapshot = [q('q1', ['a']), q('q2', ['b']), q('q3', ['c'])];
    const result = gradeExam(snapshot, { q1: ['a'], q2: ['b'], q3: ['a'] }, 90);
    expect(result.scorePercent).toBe(66);
    expect(result.passed).toBe(false);
  });

  it('gives no partial credit on multiple-choice questions', () => {
    const snapshot = [q('q1', ['a', 'b'], 1, 'multiple')];
    expect(gradeExam(snapshot, { q1: ['a'] }, 90).score).toBe(0);
    expect(gradeExam(snapshot, { q1: ['a', 'b', 'c'] }, 90).score).toBe(0);
    expect(gradeExam(snapshot, { q1: ['b', 'a'] }, 90).score).toBe(1);
  });

  it('treats missing, empty, or malformed answers as wrong', () => {
    const snapshot = [q('q1', ['a']), q('q2', ['b'])];
    const result = gradeExam(snapshot, { q2: [] }, 90);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('ignores duplicate keys in submitted answers', () => {
    const snapshot = [q('q1', ['a', 'b'], 1, 'multiple')];
    expect(gradeExam(snapshot, { q1: ['a', 'a', 'b'] }, 90).score).toBe(1);
  });

  it('respects question weight', () => {
    const snapshot = [q('q1', ['a'], 3), q('q2', ['b'], 1)];
    const result = gradeExam(snapshot, { q1: ['a'] }, 90);
    expect(result.score).toBe(3);
    expect(result.totalScore).toBe(4);
    expect(result.scorePercent).toBe(75);
  });

  it('handles an empty snapshot defensively', () => {
    const result = gradeExam([], {}, 90);
    expect(result.scorePercent).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('uses the pass threshold boundary inclusively', () => {
    const snapshot = Array.from({ length: 10 }, (_, i) => q(`q${i}`, ['a']));
    const answers = Object.fromEntries(snapshot.map((s, i) => [s.questionId, i < 9 ? ['a'] : ['b']]));
    const result = gradeExam(snapshot, answers, 90);
    expect(result.scorePercent).toBe(90);
    expect(result.passed).toBe(true);
  });
});

describe('sampleQuestions / shuffle', () => {
  it('samples the requested count without duplicates', () => {
    const pool = Array.from({ length: 50 }, (_, i) => i);
    const sampled = sampleQuestions(pool, 10);
    expect(sampled).toHaveLength(10);
    expect(new Set(sampled).size).toBe(10);
    sampled.forEach((v) => expect(pool).toContain(v));
  });

  it('returns the whole pool when count exceeds pool size', () => {
    const pool = [1, 2, 3];
    const sampled = sampleQuestions(pool, 100);
    expect(sampled).toHaveLength(3);
    expect([...sampled].sort()).toEqual([1, 2, 3]);
  });

  it('shuffle keeps all elements and does not mutate input', () => {
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    const out = shuffle(input);
    expect(input).toEqual(copy);
    expect([...out].sort()).toEqual(copy);
  });
});

describe('toPublicQuestion', () => {
  it('strips correctKeys before sending to the client', () => {
    const pub = toPublicQuestion(q('q1', ['a']));
    expect(pub).not.toHaveProperty('correctKeys');
    expect(pub.questionId).toBe('q1');
    expect(pub.options).toHaveLength(4);
  });
});
