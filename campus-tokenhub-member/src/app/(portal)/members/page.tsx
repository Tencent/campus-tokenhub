import { requireCurrentSession } from '@/lib/auth/current';
import { getConfig } from '@/lib/config';
import { buildMemberName, canEditContact, canSubmit, parseUserId } from '@/lib/members/rules';
import { findBySub, readStore } from '@/lib/members/store';
import type { MemberApplication } from '@/lib/members/types';
import { ApplicationForm } from '@/components/members/ApplicationForm';
import { ApplicationStatus } from '@/components/members/ApplicationStatus';
import { MemberAccountPanel } from '@/components/members/MemberAccountPanel';

export const dynamic = 'force-dynamic';

/** 未配置对外地址或腾讯云凭据时整体降级，不把「配置缺失」当成 500 */
function MemberUnavailableNotice() {
  return (
    <div className="mx-auto max-w-2xl rounded-card border border-line bg-white p-6 shadow-card">
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">成员账号申请暂未开放</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-600">
        门户还没有配置好腾讯云组织凭据，暂时无法提交申请。
      </p>
      <p className="mt-2 text-xs leading-relaxed text-ink-500">
        如果你是学校管理员，请到「系统设置」填写腾讯云 CAM 凭据并点一次「检测」，通过后本页自动开放。
      </p>
    </div>
  );
}

async function memberFeatureReady(): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.portal.publicBaseUrl) return false;
  if (cfg.memberAccount.provider === 'mock') return true;
  if (!cfg.tencentCloud.secretId || !cfg.tencentCloud.secretKey) return false;
  const { readStoredConfig, groupStatus } = await import('@/lib/config/store');
  return groupStatus(await readStoredConfig(), 'tencent') !== 'failed';
}

function previewMemberName(name: string, sub: string): string {
  try {
    return buildMemberName(name, parseUserId(sub));
  } catch {
    return '—';
  }
}

/**
 * 表单形态：
 * - 没有申请单 → 新建；
 * - `failed`（开通失败）→ 完整重新申请，可改部门与备注，回到 `pending` 重新审核；
 * - `pending` / `needs_email` / `needs_phone` / `rejected` → 只改联系方式后重提；
 * - `provisioning` / `active` → 不出表单。
 */
function resolveFormMode(
  application: MemberApplication | null
): 'create' | 'edit' | 'reapply' | null {
  if (!application) return 'create';
  if (canEditContact(application)) return 'edit';
  return canSubmit(application) ? 'reapply' : null;
}

export default async function MembersPage() {
  const session = await requireCurrentSession();
  // 状态卡的「能否修改」依赖当前时间：由服务端取一次，避免 SSR / hydration 两个时刻
  const now = Date.now();

  // 凭据未配齐时，直达链接给可读提示（不是 404、不白屏）
  if (!true) {
    return <MemberUnavailableNotice />;
  }

  const ready = await memberFeatureReady();

  // 申请记录是唯一数据源；部门由老师手填，页面不再拉组织架构
  const storeResult = await readStore().then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const, value: [] as MemberApplication[] })
  );

  const applications = storeResult.value;
  const loadFailed = !storeResult.ok;
  const application = findBySub(applications, session.sub) ?? null;

  const formMode = resolveFormMode(application);
  const showForm = ready && formMode !== null;
  // edit（待审核纠错）走包装组件：状态卡上给「修改」入口，点开才出表单
  const useAccountPanel = ready && formMode === 'edit' && Boolean(application);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="text-[13px] leading-[21px] text-ink-500">
          申请一枚属于自己的腾讯云集团成员账号（含账单与发票权限）。提交后由管理员审核，通过即自动开通，
          腾讯云会向你的邮箱发送激活邮件。
        </p>
      </header>

      {!ready && (
        <section className="rounded-card border border-line bg-white p-5">
          <h2 className="text-base font-semibold leading-6 text-ink-900">成员账号申请暂未开放</h2>
          <p className="mt-1 text-sm leading-6 text-ink-500">
            门户还没有配置好腾讯云组织凭据，请联系管理员后再试。
          </p>
        </section>
      )}

      {loadFailed && (
        <p role="alert" className="rounded-card border border-[#F5C2BE] bg-[#FDECEA] px-4 py-3 text-sm text-danger">
          申请数据损坏，请联系管理员；在修复前请勿重复提交，避免覆盖已有申请。
        </p>
      )}

      {application && !useAccountPanel && <ApplicationStatus application={application} now={now} />}

      {useAccountPanel && application && (
        <MemberAccountPanel
          application={application}
          applicantName={session.name || ''}
          memberNamePreview={previewMemberName(session.name, session.sub)}
          now={now}
        />
      )}

      {showForm && formMode && formMode !== 'edit' && (
        <ApplicationForm
          mode={formMode}
          applicantName={session.name || ''}
          memberNamePreview={application?.memberName ?? previewMemberName(session.name, session.sub)}
          application={application}
        />
      )}
    </div>
  );
}
