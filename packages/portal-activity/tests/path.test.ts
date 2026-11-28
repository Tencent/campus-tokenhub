import { describe, expect, it } from 'vitest';
import { normalizeVisitPath, planVisit, shouldDedupe, VISIT_PATH_MAX } from '../src/path';

describe('normalizeVisitPath', () => {
  it('保留站内路径', () => {
    expect(normalizeVisitPath('/overview')).toBe('/overview');
    expect(normalizeVisitPath('/models/gpt-4o')).toBe('/models/gpt-4o');
  });

  it('剔除查询串', () => {
    expect(normalizeVisitPath('/models?range=7d&page=2')).toBe('/models');
  });

  it('剔除 hash', () => {
    expect(normalizeVisitPath('/dashboard#top')).toBe('/dashboard');
  });

  it('先砍 hash 再砍 query', () => {
    expect(normalizeVisitPath('/a#x?y=1')).toBe('/a');
    expect(normalizeVisitPath('/a?x=1#y')).toBe('/a');
  });

  it('拒绝外站与协议相对地址', () => {
    expect(normalizeVisitPath('//evil.com/path')).toBeNull();
    expect(normalizeVisitPath('/\\evil.com')).toBeNull();
    expect(normalizeVisitPath('https://evil.com')).toBeNull();
    expect(normalizeVisitPath('evil')).toBeNull();
  });

  it('拒绝空值与异常输入', () => {
    expect(normalizeVisitPath('')).toBeNull();
    expect(normalizeVisitPath('   ')).toBeNull();
    expect(normalizeVisitPath(null)).toBeNull();
    expect(normalizeVisitPath(undefined)).toBeNull();
    expect(normalizeVisitPath(42)).toBeNull();
  });

  it('拒绝控制字符', () => {
    expect(normalizeVisitPath('/a\u0000b')).toBeNull();
    expect(normalizeVisitPath('/a\nb')).toBeNull();
  });

  it('超长路径截断到上限', () => {
    const long = `/${'a'.repeat(VISIT_PATH_MAX * 2)}`;
    expect(normalizeVisitPath(long)?.length).toBe(VISIT_PATH_MAX);
  });
});

describe('shouldDedupe', () => {
  it('首次访问不去重', () => {
    expect(shouldDedupe(null, 0, '/overview', 1000)).toBe(false);
  });

  it('同路径窗口内去重', () => {
    expect(shouldDedupe('/overview', 1000, '/overview', 1500)).toBe(true);
  });

  it('同路径超出窗口不去重', () => {
    expect(shouldDedupe('/overview', 1000, '/overview', 2500)).toBe(false);
  });

  it('不同路径不去重', () => {
    expect(shouldDedupe('/overview', 1000, '/models', 1100)).toBe(false);
  });
});

describe('planVisit（VisitTracker effect 的决策逻辑）', () => {
  it('首次渲染上报', () => {
    expect(planVisit(null, '/overview', 1000)).toEqual({
      report: true,
      path: '/overview',
      at: 1000,
    });
  });

  it('同路径 1 秒内不重复上报', () => {
    const first = planVisit(null, '/overview', 1000);
    const state = { path: '/overview', at: 1000 };

    expect(planVisit(state, '/overview', 1500)).toEqual({ report: false });
    expect(first.report).toBe(true);
  });

  it('同路径超过 1 秒后会再次上报', () => {
    expect(planVisit({ path: '/overview', at: 1000 }, '/overview', 2100)).toEqual({
      report: true,
      path: '/overview',
      at: 2100,
    });
  });

  it('路径变化立即上报，不等去重窗口', () => {
    expect(planVisit({ path: '/overview', at: 1000 }, '/models', 1010)).toEqual({
      report: true,
      path: '/models',
      at: 1010,
    });
  });

  it('非法路径不上报，也不覆盖上次状态', () => {
    expect(planVisit({ path: '/overview', at: 1000 }, '//evil.com', 1500)).toEqual({
      report: false,
    });
    expect(planVisit(null, undefined, 1500)).toEqual({ report: false });
  });

  it('去重基于规范化后的路径（query 不影响判定）', () => {
    expect(planVisit({ path: '/models', at: 1000 }, '/models?range=7d', 1200)).toEqual({
      report: false,
    });
  });
});
