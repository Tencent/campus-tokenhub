/**
 * CSV 生成与下载（浏览器端）。
 *
 * 抽出来的原因有三个容易踩的点：
 * - Excel 需要 BOM 才认 UTF-8；
 * - 单元格里的 `= + - @` 开头会被 Excel 当公式执行（CSV 注入），必须加前缀转义；
 * - `revokeObjectURL` 立刻执行会让部分浏览器取消下载，link 也必须先挂到 DOM 上。
 */

/** 以这些字符开头的单元格会被 Excel 当公式 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function escapeCell(value: string | number): string {
  let text = String(value ?? '');
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(','));
  // BOM 让 Excel 认 UTF-8，否则中文列名会乱码
  return `\uFEFF${lines.join('\n')}`;
}

/** 触发浏览器下载；link 先入 DOM，URL 延迟释放。 */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  if (typeof document === 'undefined') return;

  const blob = new Blob([buildCsv(headers, rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立即 revoke 会让部分浏览器取消下载（Safari / Firefox 实测）
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
