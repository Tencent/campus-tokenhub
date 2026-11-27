import { describe, expect, it } from 'vitest';
import { pageWindow } from '@/lib/portal/pagination';

describe('pageWindow', () => {
  it('页数不超过 5 时全部展示，不出现省略号', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('当前页在中间时，窗口跟着当前页滑动', () => {
    expect(pageWindow(8, 12)).toEqual([1, 'gap', 6, 7, 8, 9, 10, 'gap', 12]);
  });

  it('当前页靠前/靠后时补齐首尾锚点', () => {
    expect(pageWindow(2, 12)).toEqual([1, 2, 3, 4, 5, 'gap', 12]);
    expect(pageWindow(11, 12)).toEqual([1, 'gap', 8, 9, 10, 11, 12]);
  });

  it('越界页码被夹回范围内', () => {
    expect(pageWindow(0, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(99, 4)).toEqual([1, 2, 3, 4]);
  });

  it('没有数据时返回空数组', () => {
    expect(pageWindow(1, 0)).toEqual([]);
  });
});
