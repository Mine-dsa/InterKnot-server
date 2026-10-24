import { describe, expect, it } from 'vitest';
import { normalizeToolNames } from '../../src/utils/agent/resolve';

// 说明：原 agent-phase3 测试中的 normalizeModerationVerdict 所在模块
// src/utils/agent/summary-moderation 已随 summary/moderation 任务类型一并移除，
// 相关测试同步删除；此处保留仍然有效的 normalizeToolNames 测试。

describe('normalizeToolNames (3.3.3)', () => {
  it('keeps only non-empty string entries', () => {
    expect(normalizeToolNames(['search_posts', ' get_hot_posts '])).toEqual([
      'search_posts',
      'get_hot_posts',
    ]);
  });

  it('returns [] for non-array or invalid input', () => {
    expect(normalizeToolNames(null)).toEqual([]);
    expect(normalizeToolNames('search_posts')).toEqual([]);
    expect(normalizeToolNames([1, '', null, 'get_user_info'])).toEqual(['get_user_info']);
  });
});
