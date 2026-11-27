import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { appPath } from '@/lib/paths';
import { getConfig, type AppConfig } from '@/lib/config';
import { ensureConfigOverlayFresh } from '@/lib/config/overlay';
import { getAuthAdapter } from '@/lib/auth/providers/registry';
import { isWecomClient } from '@/lib/auth/providers/wecom';
import { WecomQrLogin } from '@/components/auth/WecomQrLogin';
import { adminReturnUrl, loginReuseTarget, readAdminLoginTarget, sanitizeNextPath } from '@/lib/auth/login';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import { getCurrentSession } from '@/lib/auth/current';
import { passwordLoginRiskNotice, passwordLoginState } from '@/lib/auth/local-admin';
import { isSsoConfigured } from '@/lib/config/auth-validate';
import { readableError } from '@/lib/auth/login-errors';
import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_LOGIN_TITLE,
  DEFAULT_SCHOOL_NAME,
  resolveBranding,
  type Branding,
} from '@/lib/config/branding';

export const dynamic = 'force-dynamic';

/** 品牌价值点：文案与侧边栏实际模块一致，不写未实现的能力 */
const FEATURES = [
  {
    title: '自助领取密钥',
    desc: '登录后在「密钥」页创建、轮换，并直接试调。',
    icon: KeyGlyph,
  },
  {
    title: '模型目录与示例',
    desc: '每个模型的上下文长度、计费方式与请求样例。',
    icon: GridGlyph,
  },
  {
    title: '用量随时可查',
    desc: '按天看额度消耗，最近调用记录都在「数据看板」。',
    icon: ChartGlyph,
  },
];

function KeyGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
      className="text-brand-link"
    >
      <circle cx="6.4" cy="11.6" r="3.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.2 8.8L15 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12.4 5.6L14.2 7.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GridGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
      className="text-brand-link"
    >
      <rect x="2.6" y="2.6" width="5.4" height="5.4" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="2.6" width="5.4" height="5.4" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.6" y="10" width="5.4" height="5.4" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="10" width="5.4" height="5.4" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ChartGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
      className="text-brand-link"
    >
      <path d="M3.2 15V9.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9 15V4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M14.8 15V11.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ArrowGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 8H13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path
        d="M8.6 3.6L13 8L8.6 12.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 品牌图形标：与门户侧边栏同一枚图形，登录页用白色描边 */
function BrandGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      <path
        d="M9 2.4l6.2 3.4v6.4L9 15.6 2.8 12.2V5.8L9 2.4z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M6.6 7.4v3.4c0 .6.5 1 1 1h2.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 左上品牌标识：图标 + 字标 + 门户标签 */
function BrandMark({
  size = 'lg',
  logoUrl = '',
  brandColor,
}: {
  size?: 'lg' | 'sm';
  logoUrl?: string;
  brandColor?: string;
}) {
  return (
    <div className="flex items-center gap-3.5">
      {logoUrl ? (
        // 学校自己的 Logo；尺寸固定，避免不同比例把页面顶部撑歪
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          className={`shrink-0 rounded-xl object-contain ${
            size === 'lg' ? 'h-10 w-10' : 'h-[34px] w-[34px]'
          }`}
        />
      ) : (
        <span
          aria-hidden
          style={brandColor ? { backgroundColor: brandColor } : undefined}
          className={`flex items-center justify-center rounded-xl text-white ${
            brandColor
              ? ''
              : 'bg-gradient-to-br from-brand-orange to-brand-orange-dark'
          } ${size === 'lg' ? 'h-10 w-10' : 'h-[34px] w-[34px]'}`}
        >
          <BrandGlyph size={size === 'lg' ? 21 : 18} />
        </span>
      )}
      <span className="text-[15px] font-semibold tracking-tight text-ink-900">MaaS工作台</span>
      <span className="rounded-full bg-brand-orange-soft px-2.5 py-1 text-[11px] font-medium tracking-[0.08em] text-brand-link">
        TOKENHUB
      </span>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; dest?: string }>;
}) {
  // 先等一次配置刷新：登录页直接决定「露出哪些登录入口」，
  // 拿 30 秒 TTL 里的旧值会出现「后台已把账号密码登录关掉，登录页还留着密码表单」。
  await ensureConfigOverlayFresh();

  // 守卫可能拒绝非法协议：fallback 渲染，避免整页 500 挡住管理员自助恢复
  let config: AppConfig | null = null;
  let adapter: ReturnType<typeof getAuthAdapter> | null = null;
  let authUnsafe = false;
  try {
    config = getConfig();
    adapter = getAuthAdapter(config);
  } catch {
    authUnsafe = true;
  }
  // 连 env 层都解析失败时也要能渲染出错误页：品牌信息整体回落默认值
  let branding: Branding;
  try {
    branding = resolveBranding(config ? { config } : undefined);
  } catch {
    branding = {
      schoolName: DEFAULT_SCHOOL_NAME,
      loginTitle: DEFAULT_LOGIN_TITLE,
      loginSubtitle: '',
      footerContact: '',
      brandColor: DEFAULT_BRAND_COLOR,
      logoUrl: '',
      invalidKeys: [],
    };
  }
  const { error, next, dest } = await searchParams;
  const message = readableError(authUnsafe ? 'auth_unsafe' : error);
  const target = sanitizeNextPath(next, '/overview');
  // `dest=admin`：管理台发起的登录。管理台内路径放在 next 里，由管理台自己编码
  const adminTarget = readAdminLoginTarget({ dest, next });
  // 登录态复用：已有有效会话的人不该再走一遍登录（学校 SSO 会再跳一次认证方）。
  // `authUnsafe` 时复用不成立——那时连验签都做不了，页面本身要提示去修配置。
  const session = authUnsafe ? null : await getCurrentSession();
  // 管理台目标 + 当前会话不是管理员：直接说明原因，避免用户反复点登录
  const adminDenied = Boolean(
    adminTarget && session && !(await resolvePortalAdmin(session))
  );
  if (session && !adminDenied) {
    if (adminTarget) {
      // 管理员会话直接送回管理台原页面；基址没配时留在本页，由管理台侧给出明确报错
      const adminTargetUrl = adminReturnUrl(adminTarget.adminNext);
      if (adminTargetUrl) redirect(adminTargetUrl);
    } else if (next) {
      redirect(loginReuseTarget(next, '/overview'));
    } else {
      // 没带 next：交给站点根页判断「初始化未完成 → /setup，否则 /overview」
      redirect('/');
    }
  }

  // 登录方式三选一：引导期账号密码 / 学校 SSO / 尚未配置。
  // 三者互斥，页面只渲染其中一种——关闭态不能露出任何账号密码痕迹。
  const passwordState = config ? passwordLoginState(config) : 'unconfigured';
  const ssoConfigured = config ? isSsoConfigured(config.auth) : false;
  // 服务端刚判定「已关闭」时，不能再按本副本的旧快照把表单渲染出来：
  // 内存配置有 30 秒 TTL，多副本下这里可能还没同步到最新值。
  const closedByServer = error === 'password_disabled';
  const showSso = !authUnsafe && (ssoConfigured || closedByServer);
  const passwordMode = !authUnsafe && passwordState === 'available' && !closedByServer;

  // auto 且可用时提示风险：这条通道会绕过学校 MFA 与离校回收
  const passwordRisk = passwordMode && config ? passwordLoginRiskNotice(config) : null;
  const unconfiguredMode = !authUnsafe && !passwordMode && !showSso;
  // 企微协议下，企微客户端内仍走原有 302 网页授权；系统浏览器改为内嵌扫码。
  // Next 16 的 headers() 是 async API，必须在服务端 await 后再判定 UA。
  const headerList = await headers();
  const showWecomQr =
    config?.auth.provider === 'wecom' && showSso && !isWecomClient(headerList.get('user-agent'));

  return (
    <main className="relative flex min-h-screen bg-cream">
      {/* 左栏：品牌叙事。窄屏隐藏，避免和右栏登录卡抢注意力 */}
      <section className="relative hidden w-[55%] shrink-0 flex-col justify-between overflow-hidden px-16 py-16 lg:flex">
        {/* 氛围光晕：呼应官网首屏的橙黄暖调，裁切在本栏内 */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-52 h-[560px] w-[560px] rounded-full bg-brand-orange/25 blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-40 -left-44 h-[480px] w-[480px] rounded-full bg-brand-orange/15 blur-[110px]"
        />

        <div className="relative">
          <BrandMark logoUrl={branding.logoUrl} brandColor={branding.brandColor} />
        </div>

        <div className="relative max-w-[600px]">
          <p className="text-xs font-medium tracking-[0.14em] text-brand-link">
            MaaS工作台 · {branding.schoolName}
          </p>
          <h1 className="mt-5 text-[26px] font-semibold leading-9 tracking-tight text-ink-900 lg:text-[44px] lg:leading-[60px]">
            <span className="block">一个校内账号，</span>
            <span className="block">接入学校已开通的全部 AI 模型</span>
          </h1>
          <p className="mt-5 max-w-[520px] text-[15px] leading-[26px] text-ink-700">
            密钥、模型目录、调用用量都在同一个门户里。老师备课、同学做课题，用熟悉的校内账号登录一次就能开始。
          </p>

          <ul className="mt-8 space-y-5">
            {FEATURES.map(({ title, desc, icon: Icon }) => (
              <li key={title} className="flex gap-3.5">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-brand-orange-soft"
                >
                  <Icon />
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink-900">{title}</p>
                  <p className="mt-1 text-[13px] leading-[22px] text-ink-700">{desc}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative flex items-center justify-between border-t border-line pt-6">
          <span className="text-xs text-ink-500">MaaS工作台 · 2026</span>
          <span className="text-xs text-ink-500">校内统一部署 · 支持 SSO 单点登录</span>
        </div>
      </section>

      <div aria-hidden className="hidden w-px shrink-0 bg-line lg:block" />

      {/* 右栏：认证。桌面白底承载米色卡片，窄屏米底承载白色卡片 */}
      <section className="flex flex-1 flex-col items-center justify-center px-5 py-10 lg:bg-white lg:px-20 lg:py-16">
        <div className="w-full max-w-[480px]">
          {/* 窄屏品牌头：桌面版品牌信息在左栏，这里不重复展示 */}
          <div className="mb-8 lg:hidden">
            <BrandMark size="sm" logoUrl={branding.logoUrl} brandColor={branding.brandColor} />
            <h1 className="mt-6 text-[26px] font-semibold leading-9 tracking-tight text-ink-900">
              <span className="block">一个校内账号，</span>
              <span className="block">用好学校全部的 AI 模型</span>
            </h1>
            <p className="mt-3 text-[13px] leading-[22px] text-ink-700">
              密钥、模型目录和调用用量都在同一个门户里。
            </p>
          </div>

          <div className="rounded-card border border-line bg-white p-6 shadow-pop lg:bg-cream lg:p-8">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1.5 text-[11.5px] font-medium text-brand-link">
              <span aria-hidden className="h-[5px] w-[5px] rounded-full bg-brand-orange" />
              {passwordMode
                ? ssoConfigured
                  ? '学校统一身份认证 SSO'
                  : '部署管理员入口 · 引导配置'
                : unconfiguredMode
                  ? passwordState === 'disabled_by_switch'
                    ? '登录方式已关闭'
                    : '登录方式未配置'
                  : '学校统一身份认证 SSO'}
            </span>

            <h2 className="mt-3 text-[26px] font-semibold leading-9 tracking-tight text-ink-900 lg:text-[28px]">
              {branding.loginTitle}
            </h2>
            <p className="mt-3 text-[13.5px] leading-[22px] text-ink-700">
              {passwordMode
                ? ssoConfigured
                  ? '已对接学校统一身份认证；下方保留部署管理员入口，仅在统一认证不可用时使用。'
                  : '学校统一身份认证尚未对接完成，请先用部署管理员账号登录并完成配置。确认学校账号能正常登录后，可把「账号密码登录」改为关闭。'
                : unconfiguredMode
                  ? passwordState === 'disabled_by_switch'
                    ? '账号密码登录已被部署人员关闭，学校统一认证也还没对接完成。'
                    : '当前没有可用的登录方式，需要部署人员先完成配置。'
                  : branding.loginSubtitle || '用校内账号直接登录，不用再注册一个新账号'}
            </p>

            {message && (
              <div
                role="alert"
                className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-700"
              >
                {message}
              </div>
            )}

            {adminDenied && (
              <div
                role="alert"
                className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-800"
              >
                <p>当前账号（{session?.email}）没有管理后台权限。</p>
                <p className="mt-1 text-[12px] text-amber-700">
                  请改用管理员账号，或联系管理员在「系统设置 → 管理员」里把该账号加入名单。
                </p>
                <form action={appPath('/api/auth/logout')} method="post" className="mt-2">
                  <button type="submit" className="text-[12px] font-medium underline">
                    退出当前账号并重新登录
                  </button>
                </form>
              </div>
            )}

            {authUnsafe ? (
              // 守卫已拒绝签发会话：不再给出会绕回来的登录入口，只提示去设置页修正
              <div
                aria-disabled="true"
                className="mt-6 flex h-[54px] w-full cursor-not-allowed items-center justify-center rounded-control border border-line bg-white text-[15px] font-semibold text-ink-400"
              >
                登录暂不可用，请先修正登录认证配置
              </div>
            ) : showWecomQr ? (
              // 企微 + 非企微客户端：优先内嵌扫码；即便密码救急入口开着也以 SSO 为主
              <WecomQrLogin
                next={next}
                dest={dest}
                adminNext={adminTarget?.adminNext}
              />
            ) : passwordMode ? (
              <>
                {ssoConfigured ? (
                  <>
                    {/* SSO 已齐全但部署方强制开着密码登录（PORTAL_ADMIN_LOGIN=on）：
                        正式入口仍是统一认证，密码表单降级为救急通道，不能把它藏起来。 */}
                    <a
                      href={appPath(
                        adminTarget
                          ? `/api/auth/login?dest=admin&next=${encodeURIComponent(adminTarget.adminNext)}`
                          : `/api/auth/login?next=${encodeURIComponent(next ? target : '/')}`
                      )}
                      className="mt-6 flex h-[54px] w-full items-center justify-center rounded-control bg-brand-orange text-[15px] font-semibold text-white shadow-cta transition hover:bg-brand-orange-dark focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-orange/30 active:translate-y-px"
                    >
                      使用学校账号登录
                    </a>
                    <p className="mt-4 text-center text-[12px] text-ink-500">
                      统一认证不可用时，可用部署管理员账号登录
                    </p>
                  </>
                ) : null}
              <form
                action={appPath('/api/auth/password')}
                method="post"
                className="mt-6 space-y-4"
              >
                {adminTarget ? (
                  <>
                    <input type="hidden" name="dest" value="admin" />
                    <input type="hidden" name="next" value={adminTarget.adminNext} />
                  </>
                ) : (
                  // 引导登录的唯一目的是完成 SSO 对接：一律落到设置页。
                  // 不能沿用 next——从站点根访问时中间件会带 ?next=/overview 过来，
                  // 那会把刚部署完、还没配 SSO 的人直接丢进首页，配置入口反而找不到。
                  <input type="hidden" name="next" value="/settings" />
                )}
                <label className="block">
                  <span className="text-[13px] font-medium text-ink-900">管理员账号</span>
                  <input
                    name="username"
                    required
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="mt-1.5 h-[46px] w-full rounded-control border border-line bg-white px-3.5 text-[15px] text-ink-900 outline-none transition focus-visible:border-brand-orange focus-visible:ring-4 focus-visible:ring-brand-orange/20"
                  />
                </label>
                <label className="block">
                  <span className="text-[13px] font-medium text-ink-900">密码</span>
                  <input
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    className="mt-1.5 h-[46px] w-full rounded-control border border-line bg-white px-3.5 text-[15px] text-ink-900 outline-none transition focus-visible:border-brand-orange focus-visible:ring-4 focus-visible:ring-brand-orange/20"
                  />
                </label>
                {passwordRisk ? (
                  <p className="text-[12px] leading-relaxed text-amber-700">{passwordRisk}</p>
                ) : null}
                <button
                  type="submit"
                  className="flex h-[54px] w-full items-center justify-center rounded-control bg-brand-orange text-[15px] font-semibold text-white shadow-cta transition hover:bg-brand-orange-dark focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-orange/30 active:translate-y-px"
                >
                  登录并继续配置
                </button>
              </form>
              </>
            ) : unconfiguredMode ? (
              // 既没有可用 SSO 也没有可用引导账号：不给会连点两次都失败的按钮
              <div className="mt-6 rounded-control border border-line bg-white px-4 py-3.5 text-[13px] leading-[22px] text-ink-700">
                <p className="font-semibold text-ink-900">
                  {passwordState === 'disabled_by_switch' ? '登录方式已关闭' : '登录方式尚未配置'}
                </p>
                {passwordState === 'disabled_by_switch' ? (
                  <p className="mt-1">
                    部署人员已把「账号密码登录」设为 <code>off</code>，且学校 SSO
                    尚未对接完成。请联系部署人员完成 SSO 对接，或临时改回 <code>auto</code>{' '}
                    后用引导账号登录配置。
                  </p>
                ) : (
                  <p className="mt-1">
                    请联系部署人员配置 <code>PORTAL_ADMIN_USERNAME</code> /{' '}
                    <code>PORTAL_ADMIN_PASSWORD</code>，或完成学校 SSO 对接后使用统一认证登录。
                  </p>
                )}
              </div>
            ) : (
              <>
                <a
                  href={appPath(
                    adminTarget
                      ? `/api/auth/login?dest=admin&next=${encodeURIComponent(adminTarget.adminNext)}`
                      : `/api/auth/login?next=${encodeURIComponent(target)}`
                  )}
                  className="mt-6 flex h-[54px] w-full items-center justify-center gap-2.5 rounded-control bg-brand-orange text-[15px] font-semibold text-white shadow-cta transition hover:bg-brand-orange-dark focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-orange/30 active:translate-y-px"
                >
                  {adapter?.label || '学校统一身份认证登录'}
                  <span
                    aria-hidden
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-white/45"
                  >
                    <ArrowGlyph />
                  </span>
                </a>
                <p className="mt-2.5 text-center text-[11.5px] text-ink-500">
                  将跳转至学校统一身份认证页面，无需在此输入密码
                </p>
              </>
            )}

            <hr className="my-6 h-px border-0 bg-cream-200" />

            <p className="flex items-start gap-2 text-xs leading-[18px] text-ink-700">
              <span aria-hidden className="mt-[2px] shrink-0">
                <KeyGlyph />
              </span>
              {passwordMode
                ? '该账号仅用于完成 SSO 对接，不会在网关开通个人密钥空间'
                : unconfiguredMode
                  ? '配置完成后，师生用校内账号即可登录'
                  : '首次登录自动开通个人密钥空间，可在「密钥」中查看'}
            </p>
          </div>

          <div className="mt-5 space-y-2">
            <p className="text-xs text-ink-700">
              {branding.footerContact || '账号无法登录？联系学校信息化办公室协助开通'}
            </p>
            <p className="text-xs leading-5 text-ink-500">
              登录即表示同意学校的信息化使用规范；密钥仅限本人使用，请勿外传
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
