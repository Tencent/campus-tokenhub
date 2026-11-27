/**
 * 引导期账号密码登录（bootstrap admin）。
 *
 * 解决的问题：`/settings` 需要「有效会话 + 全局管理员」，而会话只能由 SSO 签发。
 * 学校还没对接 SSO 的部署因此永远进不去设置页。这里提供一条**部署方自己掌握**的
 * 本地管理员通道。
 *
 * 三条红线：
 * 1. 关闭判据只有一条：运维显式把开关置 `off`。**SSO 配齐不再自动关闭**——
 *    参数填齐不等于调得通（密钥错、回调未登记、字段映射不对都很常见），
 *    自动关闭会在最需要排障的时候把人锁在门外，连改回来的入口都没有。
 *    因此保留一条随时可用的救急通道，由部署方确认调试通过后自己关。
 * 2. 凭据来源顺序固定：**共享配置（设置页保存的值 / 首次部署种子）> 环境变量**。
 *    库内没有口令时，启动期把 `.env` 这套加密写进 `portal_shared.login_config`
 *    （与设置页同一列，见 `seedLocalAdminCredentialFromEnv`）；一旦库内有值，
 *    env 不再参与校验。双站同域部署因此读的是同一行，不会出现
 *    「采买站能登、成员站登不上」而两边容器都 healthy 的悬案。
 *    凭据不出接口、不进日志；比较用 sha256 + timingSafeEqual，长度不泄露。
 * 3. 已签发的密码会话也在请求期复核（`isPasswordSessionAllowed`），
 *    置 `off` 后旧会话立即失效，不留绕开学校统一认证的后门。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { getConfig, type AppConfig } from '@/lib/config';

/** 密码登录的三种状态：页面与接口只按这个决定「给不给入口」 */
export type PasswordLoginState = 'available' | 'disabled_by_switch' | 'unconfigured';

/** 只关心会话里的登录方式，避免把整个 SessionPayload 拖进来（middleware 也会用到类型） */
export type PasswordSessionLike = { login_method?: 'password' };

function normalizeUsername(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * 当前是否可以账号密码登录。
 *
 * 顺序有讲究：`off` 是运维的显式意志，优先级最高；没有凭据时无论开关怎么设都不可用；
 * 其余情况（`auto` / `on`）一律可用——SSO 是否配齐不参与判定。
 *
 * 刻意不做内存缓存：判据只有几个字段比较，而缓存一旦与配置对象身份不一致，
 * 就会在开关改回 `off` 之后继续返回 available —— 那正是本模块要防的事。
 */
export function passwordLoginState(cfg: AppConfig = getConfig()): PasswordLoginState {
  const { username, password, mode } = cfg.portal.localAdmin;
  if (mode === 'off') return 'disabled_by_switch';
  if (!username || !password) return 'unconfigured';
  return 'available';
}

export function canUsePasswordLogin(cfg: AppConfig = getConfig()): boolean {
  return passwordLoginState(cfg) === 'available';
}

/** 密码登录的风险提示文案（登录页、设置页、启动日志共用同一份，避免三处说法不一致） */
export const PASSWORD_LOGIN_RISK_NOTICE =
  '账号密码登录会绕过学校统一认证的 MFA 与离校回收：确认学校账号能登录后，请把「账号密码登录」改为 off';

/**
 * 需要展示风险提示时返回文案，否则返回 null。
 *
 * 只在「此刻真的能用」且运维没有显式关掉（mode=auto）时提示：
 * mode=on 是运维的显式选择，不再劝；off / unconfigured 根本没有入口可提示。
 */
export function passwordLoginRiskNotice(cfg: AppConfig = getConfig()): string | null {
  if (passwordLoginState(cfg) !== 'available') return null;
  return cfg.portal.localAdmin.mode === 'auto' ? PASSWORD_LOGIN_RISK_NOTICE : null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * 校验账号口令。
 *
 * 两侧都做一次 sha256 再比较，既保证常量时间，也不泄露口令长度。
 * 用户名忽略大小写与首尾空白（人记不住大小写），口令严格按原样比较（不 trim，
 * 避免「复制时多带一个空格也能登」这种看似方便实则削弱口令的做法）。
 */
export function verifyLocalAdminCredentials(
  cfg: AppConfig,
  username: string,
  password: string
): boolean {
  const expected = cfg.portal.localAdmin;
  if (!expected.username || !expected.password) return false;

  // 两次比较都要执行：不能因为用户名不匹配就短路，否则响应时间会泄露用户名是否正确
  const usernameMatches = timingSafeEqual(
    digest(normalizeUsername(username)),
    digest(normalizeUsername(expected.username))
  );
  const passwordMatches = timingSafeEqual(digest(password), digest(expected.password));
  return usernameMatches && passwordMatches;
}

/**
 * 密码登录成功后写入会话的固定身份。
 *
 * `local:` 前缀与 SSO 的 `school_id:user_id` 形态不同，不会撞车；
 * `@local` 只用于界面署名，不会参与任何网关调用（该类身份不开户）。
 */
export function localAdminIdentity(
  cfg: AppConfig = getConfig()
): { sub: string; email: string; name: string } | null {
  const username = normalizeUsername(cfg.portal.localAdmin.username);
  if (!username || !cfg.portal.localAdmin.password) return null;
  return { sub: `local:${username}`, email: `${username}@local`, name: username };
}

/**
 * 该 sub 是否是当前的引导期管理员身份。
 *
 * 用于 `resolvePortalAdmin()`：这个身份不在数据库管理员名单里（也不该被写进去），
 * 必须在同一口径里显式放行，否则会出现「页面放行、接口 403」。
 */
export function isLocalAdminSub(sub: string, cfg: AppConfig = getConfig()): boolean {
  if (!sub) return false;
  const identity = localAdminIdentity(cfg);
  return identity !== null && identity.sub === sub;
}

/**
 * 请求期复核：密码会话在「已不允许密码登录」后立即失效。
 *
 * SSO 会话恒为真——本函数只负责关掉后门，不影响正常登录态。
 */
export function isPasswordSessionAllowed(
  session: PasswordSessionLike,
  cfg: AppConfig = getConfig()
): boolean {
  if (session.login_method !== 'password') return true;
  return canUsePasswordLogin(cfg);
}

/**
 * 引导凭据的指纹（不含明文，只用于跨站比对）。
 *
 * 用户名按登录校验同一口径归一（去空白、小写），口令按原样（不 trim），
 * 因此「能不能登进去」与「指纹是否相同」是同一件事。
 */
export function credentialFingerprint(username: string, password: string): string | null {
  const normalized = normalizeUsername(username);
  if (!normalized || !password) return null;
  return createHash('sha256')
    .update(`v1:${normalized}\u0000${password}`, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

/** 当前生效凭据的指纹；与 `credentialFingerprint` 同一口径，用于比对「env 值 vs 库内值」 */
export function localAdminFingerprint(cfg: AppConfig = getConfig()): string | null {
  return credentialFingerprint(cfg.portal.localAdmin.username, cfg.portal.localAdmin.password);
}

/** 启动期种子的结果，只影响日志措辞，不参与任何判定 */
export type LocalAdminSeedState = 'seeded' | 'exists' | 'no_env' | 'no_db' | 'failed';

/**
 * 把本侧 `.env` 里的部署管理员凭据写进共享配置——**只在库内为空时**。
 *
 * 双站同域部署的同一个事实：管理员名单、登录配置都在共享库里，只有这组凭据
 * 各自从容器环境变量取。让共享库当唯一权威，两站读同一行，口径就不可能岔开；
 * `seedIfEmpty` 里的条件 UPDATE 保证并发启动时只有一侧写成功，另一侧读到同一份。
 *
 * 只在启动期调用一次。写成功后立刻刷新 overlay，让**本进程**也用库里的值（而不是
 * 自己刚写的 env 值），避免「先写后读」在极端并发下各拿一份。
 *
 * 失败（库不可达、密钥缺失等）只降级告警：本次启动仍按 `.env` 生效，不影响登录能力。
 */
export async function seedLocalAdminCredentialFromEnv(
  options: { env?: Record<string, string | undefined>; repo?: import('@/lib/config/store').ConfigRepo } = {}
): Promise<LocalAdminSeedState> {
  const env = options.env ?? process.env;
  const username = (env.PORTAL_ADMIN_USERNAME ?? '').trim();
  const password = env.PORTAL_ADMIN_PASSWORD ?? '';
  if (!username || !password) return 'no_env';

  try {
    // 动态 import：本模块在认证与中间件的公共 import 链上，静态引入会把 pg 拖进 edge 打包
    if (!options.repo) {
      const { isPortalDbConfigured } = await import('@/lib/db/portal-db');
      if (!isPortalDbConfigured()) return 'no_db';
      const { ensurePortalSchema } = await import('@/lib/db/portal-schema');
      await ensurePortalSchema();
    }

    const { seedLocalAdminCredentialIfEmpty } = await import('@/lib/config/store');
    const seeded = await seedLocalAdminCredentialIfEmpty(username, password, options.repo);
    if (!seeded) return 'exists';

    if (!options.repo) {
      const { refreshConfigOverlay } = await import('@/lib/config/overlay');
      await refreshConfigOverlay();
    }
    return 'seeded';
  } catch (error) {
    console.warn(
      '[portal] 部署管理员凭据未能写入共享配置，本次启动仍按 .env 生效：' +
        (error instanceof Error ? error.message : String(error))
    );
    return 'failed';
  }
}
