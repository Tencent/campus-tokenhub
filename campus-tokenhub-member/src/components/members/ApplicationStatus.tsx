'use client';

import { describeStatus } from '@/lib/members/presentation';
import type { MemberApplication } from '@/lib/members/types';

const TONE_CLASS: Record<string, string> = {
  neutral: 'border-line bg-cream-100 text-ink-700',
  info: 'border-[#C7D7F9] bg-[#EEF3FE] text-brand-link',
  success: 'border-[#BFE3CE] bg-[#E8F5EE] text-[#17914F]',
  warning: 'border-[#F3D9A8] bg-[#FDF6E7] text-[#9A6A00]',
  danger: 'border-[#F5C2BE] bg-[#FDECEA] text-danger',
};

type Props = {
  application: MemberApplication;
  /**
   * 由服务端传入的「当前时间」：`describeStatus` 内部默认取 `Date.now()`，
   * 客户端组件在 SSR 与 hydration 时会得到两个时刻，2 分钟阈值附近会出现按钮闪烁。
   */
  now?: number;
  /** 传入则展示「修改」入口；点击后由父组件展开修改表单 */
  onEdit?: () => void;
  /** 修改表单已展开时隐藏入口，避免重复点击 */
  editing?: boolean;
};

/** 申请单状态卡：只说老师能行动的事，不暴露错误码与 RequestId。 */
export function ApplicationStatus({ application, now, onEdit, editing = false }: Props) {
  const view = describeStatus(application, now);
  // 已开通的单只展示审核时实际落到的节点路径（无则 —）；未开通时展示申请人填的路径
  const departmentLabel =
    application.status === 'active'
      ? application.resolvedNodePath || ''
      : application.departmentPath;

  return (
    <section className="rounded-card border border-line bg-white p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold leading-6 text-ink-900">我的成员账号申请</h2>
        <span className={`rounded-[4px] border px-2 py-0.5 text-[11px] ${TONE_CLASS[view.tone]}`}>
          {view.title}
        </span>
        {onEdit && view.canEditContact && !editing && (
          <button
            type="button"
            onClick={onEdit}
            className="ml-auto flex h-8 items-center rounded-control border border-line bg-white px-3 text-[13px] font-medium text-ink-900 transition hover:border-ink-300 hover:bg-cream-100"
          >
            修改
          </button>
        )}
      </div>

      <p className="mt-2 text-sm leading-6 text-ink-700">{view.description}</p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-500">成员名</dt>
          <dd className="mt-1 truncate text-sm text-ink-900">{application.memberName}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">所属部门</dt>
          <dd className="mt-1 truncate text-sm text-ink-900">
            {application.status === 'active' ? (
              departmentLabel || '—'
            ) : (
              departmentLabel || <span className="text-danger">待补填部门</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-500">联系邮箱</dt>
          <dd className="mt-1 truncate text-sm text-ink-900">{application.email}</dd>
        </div>
      </dl>

      {!departmentLabel && view.canEditContact && (
        <p className="mt-3 text-xs leading-5 text-ink-500">
          请点击右上角「修改」补填所属部门（用 / 分隔多级，例如 教务处/数学组）；补填后管理员才能审核开通。
        </p>
      )}

      {application.status === 'active' && application.uin && (
        <p className="mt-3 text-xs leading-5 text-ink-500">成员账号 Uin：{application.uin}</p>
      )}
    </section>
  );
}
