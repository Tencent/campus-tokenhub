import { canRetry } from '@/lib/members/rules';
import { describeStatus } from '@/lib/members/presentation';
import type { MemberApplication } from '@/lib/members/types';
import { ReviewActions } from './ReviewActions';
import { DeleteMemberButton } from './DeleteMemberButton';

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}`;
}

/** 管理员审核列表：待审核优先，行内展开详情与操作。 */
export function ReviewList({ applications }: { applications: MemberApplication[] }) {
  if (applications.length === 0) {
    return (
      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-base font-semibold leading-6 text-ink-900">暂无申请</h2>
        <p className="mt-1 text-sm text-ink-500">老师提交申请后会出现在这里；若长时间为空，确认老师已用学校账号登录过门户。</p>
      </section>
    );
  }

  const now = Date.now();

  return (
    <div className="flex flex-col gap-3">
      {applications.map((application) => {
        const view = describeStatus(application, now);
        const retryable = canRetry(application, now);

        return (
          <details
            key={application.id}
            className="rounded-card border border-line bg-white p-5"
            open={application.status === 'pending'}
          >
            <summary className="flex cursor-pointer flex-wrap items-center gap-3 text-sm text-ink-900">
              <span className="font-medium">{application.memberName}</span>
              <span className="rounded-[4px] border border-line px-2 py-0.5 text-[11px] text-ink-700">
                {view.title}
              </span>
              {application.revision > 0 && (
                <span className="rounded-[4px] border border-[#F3D9A8] bg-[#FDF6E7] px-2 py-0.5 text-[11px] text-[#9A6A00]">
                  修改后重提 · 第 {application.revision} 次
                </span>
              )}
              <span className="text-xs text-ink-500">
                {application.applicantName} · {formatTime(application.updatedAt)}
              </span>
            </summary>

            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-ink-500">邮箱</dt>
                <dd className="mt-0.5 break-all text-ink-900">{application.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">手机号</dt>
                <dd className="mt-0.5 text-ink-900">
                  +{application.countryCode} {application.phone}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">部门</dt>
                <dd className="mt-0.5 text-ink-900">
                  {application.departmentPath || (
                    <span className="text-danger">申请人尚未补填部门</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">申请人身份</dt>
                <dd className="mt-0.5 text-ink-900">{application.applicantSub}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">提交次数</dt>
                <dd className="mt-0.5 text-ink-900">
                  {application.revision > 0
                    ? `${application.revision + 1} 次（修改后重提 ${application.revision} 次）`
                    : '首次提交'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Uin</dt>
                <dd className="mt-0.5 text-ink-900">{application.uin ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">最近尝试</dt>
                <dd className="mt-0.5 text-ink-900">{formatTime(application.lastAttemptAt)}</dd>
              </div>
            </dl>

            {application.remark && (
              <p className="mt-2 text-xs text-ink-500">备注：{application.remark}</p>
            )}

            {application.errorCode && (
              <p className="mt-2 break-all rounded-control bg-cream-100 px-3 py-2 text-xs text-ink-500">
                原始错误：{application.errorCode}
                {application.tencentRequestId ? ` · RequestId ${application.tencentRequestId}` : ''}
              </p>
            )}

            {application.reviewNote && (
              <p className="mt-2 text-xs text-ink-500">上次驳回理由：{application.reviewNote}</p>
            )}

            {application.status === 'active' && application.uin ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-cream-200 pt-3">
                <span className="text-xs text-ink-500">
                  已开通账号 · UIN {application.uin}
                  {application.deletedAt ? '' : ''}
                </span>
                <DeleteMemberButton
                  applicationId={application.id}
                  memberName={application.memberName}
                  uin={application.uin}
                />
              </div>
            ) : null}

            {application.status === 'removing' ? (
              <p className="mt-3 rounded-control bg-cream-100 px-3 py-2 text-xs text-ink-600">
                正在删除，通常几秒内完成。若长时间停在这里，重新点击删除会按「中断重试」补正。
              </p>
            ) : null}

            {application.status === 'deleted' ? (
              <p className="mt-3 rounded-control bg-cream-100 px-3 py-2 text-xs text-ink-600">
                已于 {formatTime(application.deletedAt)} 从腾讯云组织移除
                {application.uin ? `（UIN ${application.uin}）` : ''}。记录保留用于追溯，本人可重新申请。
              </p>
            ) : null}

            {application.deleteError && application.status === 'active' ? (
              <p role="alert" className="mt-2 break-all rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-xs text-danger">
                上次删除失败：{application.deleteError}
              </p>
            ) : null}

            <ReviewActions
              applicationId={application.id}
              canRetry={
                retryable &&
                application.status !== 'pending' &&
                application.departmentPath.trim().length > 0
              }
              isPending={application.status === 'pending'}
              canApprove={application.departmentPath.trim().length > 0}
            />

            {application.events.length > 0 && (
              <ol className="mt-3 flex flex-col gap-1 border-t border-cream-200 pt-3">
                {[...application.events].reverse().map((event, index) => (
                  <li key={`${event.at}-${index}`} className="text-xs text-ink-500">
                    {formatTime(event.at)} · {event.from ?? '新建'} → {event.to}
                    {event.note ? ` · ${event.note}` : ''}
                  </li>
                ))}
              </ol>
            )}
          </details>
        );
      })}
    </div>
  );
}
