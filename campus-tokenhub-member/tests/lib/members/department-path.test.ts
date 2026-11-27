import { describe, expect, it } from 'vitest';
import {
  DEPARTMENT_MAX_LEVELS,
  DEPARTMENT_SEGMENT_MAX,
  normalizeDepartmentPath,
} from '@/lib/members/department-path';

describe('normalizeDepartmentPath', () => {
  it('合法两级路径', () => {
    expect(normalizeDepartmentPath('教务处/数学组')).toEqual({
      ok: true,
      path: '教务处/数学组',
      segments: ['教务处', '数学组'],
      errors: [],
    });
  });

  it('全角斜杠、反斜杠与空白被归一化', () => {
    expect(normalizeDepartmentPath('  教务处  ／  数学组 ').path).toBe('教务处/数学组');
    expect(normalizeDepartmentPath('教务处\\数学组').path).toBe('教务处/数学组');
    expect(normalizeDepartmentPath('教务处＼数学组').path).toBe('教务处/数学组');
  });

  it('首尾斜杠被忽略', () => {
    expect(normalizeDepartmentPath('/教务处/数学组/').path).toBe('教务处/数学组');
    expect(normalizeDepartmentPath('教务处/').path).toBe('教务处');
  });

  it('中间空层报错', () => {
    const result = normalizeDepartmentPath('教务处//数学组');
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toContain('不能为空');
  });

  it('只有斜杠视为空层，真空白视为未填写', () => {
    for (const raw of ['', '   ']) {
      const result = normalizeDepartmentPath(raw);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.message).toContain('请填写部门');
    }
    for (const raw of ['/', '///', ' // ']) {
      const result = normalizeDepartmentPath(raw);
      expect(result.ok).toBe(false);
      expect(result.errors[0]?.message).toBe('层与层之间不能为空，请用 / 分隔多级部门');
    }
  });

  it('null / undefined 按未填写处理', () => {
    expect(normalizeDepartmentPath(null).ok).toBe(false);
    expect(normalizeDepartmentPath(undefined).ok).toBe(false);
    expect(normalizeDepartmentPath(null).errors[0]?.message).toContain('请填写部门');
  });

  it('超过层级上限报错，且只统计真实层级', () => {
    const result = normalizeDepartmentPath('a/b/c/d');
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.message).toBe('最多支持 3 级部门，当前填了 4 级');
    expect(result.errors[0]?.index).toBe(0);

    // 空层不算一级：a//b/c 是 3 级 + 1 个空层，不能报成 4 级
    const withEmpty = normalizeDepartmentPath('a//b/c');
    expect(withEmpty.errors.map((item) => item.message)).toEqual([
      '层与层之间不能为空，请用 / 分隔多级部门',
    ]);
  });

  it('正好达到层级上限时通过', () => {
    const result = normalizeDepartmentPath('a/b/c');
    expect(result.ok).toBe(true);
    expect(result.segments).toHaveLength(DEPARTMENT_MAX_LEVELS);
  });

  it('单级长度按 Unicode 码点计数：BMP 与补充平面字符都按 1 个字符算', () => {
    const bmp = '一'.repeat(DEPARTMENT_SEGMENT_MAX);
    expect(normalizeDepartmentPath(bmp).ok).toBe(true);
    expect(normalizeDepartmentPath(`${bmp}一`).ok).toBe(false);

    // 𠀀 是补充平面字符（UTF-16 下占 2 个 code unit）：若实现用 .length，会在这组用例失败
    const astral = '𠀀'.repeat(DEPARTMENT_SEGMENT_MAX);
    expect(normalizeDepartmentPath(astral).ok).toBe(true);
    const astralTooLong = normalizeDepartmentPath(`${astral}𠀀`);
    expect(astralTooLong.ok).toBe(false);
    expect(astralTooLong.errors[0]?.message).toContain(String(DEPARTMENT_SEGMENT_MAX));
  });

  it('归一化幂等：ok=true 时 path 与 segments 一致，再次归一化结果不变', () => {
    const once = normalizeDepartmentPath(' /教务处 ／ 数学组/ ');
    expect(once.ok).toBe(true);
    expect(once.path).toBe(once.segments.join('/'));
    expect(normalizeDepartmentPath(once.path).path).toBe(once.path);
  });

  it('非法字符定位到具体层级', () => {
    const result = normalizeDepartmentPath('教务处/数 学组');
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.index).toBe(2);
    expect(result.errors[0]?.message).toContain('第 2 级');
  });

  it('不允许的符号被拒绝，允许集合内的符号通过', () => {
    for (const bad of ['教务处（东区）', '教务处#1', '教务处:东区', '教务处,东区']) {
      expect(normalizeDepartmentPath(bad).ok).toBe(false);
    }
    expect(normalizeDepartmentPath('Teaching+Admin_1@x&y.z[a]-b').ok).toBe(true);
  });

  it('"." 与 ".." 层被拒绝', () => {
    expect(normalizeDepartmentPath('..').ok).toBe(false);
    expect(normalizeDepartmentPath('教务处/.').ok).toBe(false);
  });

  it('多个错误一次性返回', () => {
    const result = normalizeDepartmentPath('a b/c d/e f/g h');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
