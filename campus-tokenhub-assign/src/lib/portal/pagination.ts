/**
 * 页码窗口计算（纯函数，便于单测）。
 *
 * 规则：以当前页为中心取最多 5 个页码，两端各补首页/末页锚点，中间用 'gap' 表示省略号。
 */

export type PageItem = number | 'gap';

const WINDOW_SIZE = 5;

export function pageWindow(page: number, pageCount: number, size = WINDOW_SIZE): PageItem[] {
  if (pageCount <= 0) return [];

  const current = Math.min(Math.max(Math.trunc(page) || 1, 1), pageCount);
  const width = Math.min(pageCount, Math.max(size, 3));
  let start = Math.max(1, current - Math.floor(width / 2));
  const end = Math.min(pageCount, start + width - 1);
  start = Math.max(1, end - width + 1);

  const items: PageItem[] = [];
  if (start > 1) {
    items.push(1);
    if (start > 2) items.push('gap');
  }
  for (let value = start; value <= end; value += 1) items.push(value);
  if (end < pageCount) {
    if (end < pageCount - 1) items.push('gap');
    items.push(pageCount);
  }
  return items;
}
