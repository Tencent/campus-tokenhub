'use client';

import { downloadCsv } from '@/lib/portal/csv';

/** 导出当前区间的用量趋势为 CSV（浏览器本地生成，不经过服务端） */
export function ExportCsvButton({
  headers,
  rows,
  filename,
}: {
  headers: string[];
  rows: (string | number)[][];
  filename: string;
}) {
  return (
    <button
      type="button"
      onClick={() => downloadCsv(filename, headers, rows)}
      className="flex items-center gap-1 text-xs leading-5 text-ink-500 transition hover:text-ink-900"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M6 1.8v6.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M3.6 6l2.4 2.4L8.4 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2 10.2h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      导出 CSV
    </button>
  );
}
