import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearBlocked,
  excludeStatus,
  filterByAllowlist,
  getBlocked,
  isBlocked,
  isModelAllowed,
  markBlocked,
  parseAllowlist,
} from '@/lib/playground/allowlist';

beforeEach(() => {
  clearBlocked();
});

describe('parseAllowlist / isModelAllowed', () => {
  it('逗号列表去空白与空项', () => {
    expect(parseAllowlist(' a , ,b ')).toEqual(['a', 'b']);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist(null)).toEqual([]);
  });

  it('白名单为空表示不限', () => {
    expect(isModelAllowed('anything', [])).toBe(true);
  });

  it('非空时只放行名单内模型', () => {
    expect(isModelAllowed('hy4', ['hy4'])).toBe(true);
    expect(isModelAllowed('glm-5.3', ['hy4'])).toBe(false);
  });
});

describe('filterByAllowlist', () => {
  const models = [{ id: 'hy4' }, { id: 'glm-5.3' }];

  it('空名单回退为全部', () => {
    expect(filterByAllowlist(models, [])).toHaveLength(2);
  });

  it('非空名单只保留命中项', () => {
    expect(filterByAllowlist(models, ['glm-5.3']).map((model) => model.id)).toEqual(['glm-5.3']);
  });
});

describe('excludeStatus', () => {
  it('discontinued 始终排除', () => {
    const models = [{ id: 'a' }, { id: 'b', status: 'discontinued' }, { id: 'c', status: 'active' }];
    expect(excludeStatus(models).map((model) => model.id)).toEqual(['a', 'c']);
  });
});

describe('402 之后的本地黑白名单', () => {
  it('标记后当次会话内被过滤', () => {
    markBlocked('seedream-image-v5.0-pro');

    expect(isBlocked('seedream-image-v5.0-pro')).toBe(true);
    expect(getBlocked()).toEqual(['seedream-image-v5.0-pro']);
  });

  it('重复标记不会产生重复项，clear 后恢复', () => {
    markBlocked('x');
    markBlocked('x');
    expect(getBlocked()).toEqual(['x']);

    clearBlocked();
    expect(isBlocked('x')).toBe(false);
  });
});
