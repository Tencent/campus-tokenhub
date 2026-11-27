import { rosterNoticeContent, type RosterNoticeKind } from '@/lib/admin/roster-notice';

/**
 * 名单为空的置顶警示（服务端渲染，无客户端状态）。
 *
 * 文案与判定都在 `lib/admin/roster-notice.ts`，两站共用同一套说法。
 */
export function RosterEmptyNotice({ kind }: { kind: RosterNoticeKind }) {
  const content = rosterNoticeContent(kind);

  return (
    <div
      role="alert"
      className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-relaxed text-amber-900"
    >
      <p className="font-semibold">{content.title}</p>
      <p className="mt-1">{content.body}</p>
    </div>
  );
}
