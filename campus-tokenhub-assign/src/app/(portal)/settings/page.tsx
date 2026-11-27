import Link from 'next/link';
import { requireCurrentSession } from '@/lib/auth/current';
import { AUTH_CALLBACK_PATH } from '@/lib/auth/login';
import { appPath } from '@/lib/paths';
import { canManageSettings } from '@/lib/config/settings-access';
import { loadSettingsPayload } from '@/lib/config/settings-view';
import { getConfig } from '@/lib/config';
import { ensureConfigOverlayFresh } from '@/lib/config/overlay';
import { isSsoConfigured } from '@/lib/config/auth-validate';
import { passwordLoginState } from '@/lib/auth/local-admin';
import { SettingsShell } from '@/components/settings/SettingsShell';

export const dynamic = 'force-dynamic';

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-card border border-line bg-white p-6 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        <div className="mt-2 space-y-2 text-sm text-ink-600">{children}</div>
        <Link
          href="/overview"
          className="mt-5 inline-block rounded-full border border-line px-4 py-1.5 text-sm text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
        >
          返回我的算力
        </Link>
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  const session = await requireCurrentSession();

  if (!(await canManageSettings(session))) {
    return (
      <Notice title="设置仅对全局管理员开放">
        <p>当前账号不是全局管理员。需要调整学校配置时，请联系学校管理员操作。</p>
      </Notice>
    );
  }

  // 先等一次配置刷新：管理员刚在界面上改完「账号密码登录」，页面顶部横幅与
  // 「当前状态」都要立刻反映新值，不能等 30 秒 TTL 过期
  await ensureConfigOverlayFresh();

  let payload;
  try {
    payload = await loadSettingsPayload();
  } catch {
    return (
      <Notice title="暂时读不到配置">
        <p>
          门户无法连接配置库，请确认容器已启动、<code>PORTAL_DATABASE_URL</code> 配置正确后刷新重试。
        </p>
        <p>此时全站仍按环境变量运行，不影响师生使用。</p>
      </Notice>
    );
  }

  // 登录方式状态由服务端算：它同时依赖 env 凭据与 DB 里的 SSO 参数，客户端拿不到全貌
  const authConfig = getConfig();
  const loginState = passwordLoginState(authConfig);
  const ssoConfigured = isSsoConfigured(authConfig.auth);
  // 企微后台登记用的回调地址：PUBLIC_BASE_URL 为空时只展示带部署前缀的路径
  const callbackPath = appPath(AUTH_CALLBACK_PATH);
  const publicBaseUrl = authConfig.portal.publicBaseUrl.replace(/\/+$/, '');
  const callbackUrl = publicBaseUrl
    ? new URL(callbackPath, publicBaseUrl).toString()
    : callbackPath;

  return (
    <SettingsShell
      initial={payload}
      loginState={{ password: loginState, ssoConfigured }}
      callbackUrl={callbackUrl}
    />
  );
}
