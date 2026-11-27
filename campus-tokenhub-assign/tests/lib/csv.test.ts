import { describe, expect, it } from 'vitest';
import { buildCsv } from '@/lib/portal/csv';

describe('buildCsv', () => {
  it('带 BOM，Excel 才能识别 UTF-8', () => {
    expect(buildCsv(['名称'], [['张三']])).toBe('\uFEFF名称\n张三');
  });

  it('逗号 / 引号 / 换行需要转义', () => {
    expect(buildCsv(['a'], [['x,y']])).toContain('"x,y"');
    expect(buildCsv(['a'], [['say "hi"']])).toContain('"say ""hi"""');
    expect(buildCsv(['a'], [['line1\nline2']])).toContain('"line1\nline2"');
  });

  it('公式前缀被转义，避免 CSV 注入', () => {
    expect(buildCsv(['a'], [['=1+1']])).toContain("'=1+1");
    expect(buildCsv(['a'], [['+86']])).toContain("'+86");
    expect(buildCsv(['a'], [['-1']])).toContain("'-1");
    expect(buildCsv(['a'], [['@cmd']])).toContain("'@cmd");
  });

  it('空值不产生 undefined / null 文本', () => {
    const csv = buildCsv(['a', 'b'], [[1, '']]);
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('null');
  });
});
