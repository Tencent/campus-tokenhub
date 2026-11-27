/**
 * 环境变量集中解析与校验。
 *
 * 只在这里读 `process.env`，其它模块一律从 `getConfig()` 拿，方便测试时注入。
 * 校验失败抛中文错误，直接暴露给运维看，不做二次包装。
 */

import { DEFAULT_WECOM_SCOPE, type RestrictCondition, type WecomScope } from './config/fields';
import {
  applyOverlay,
  emptyOverlayStored,
  getOverlaySnapshot,
  resetOverlayForTests,
} from './config/overlay';

/** SSO 协议：OAuth2（校内 AI 门户授权码）、CAS（学校统一认证）、企业微信（自建应用） */
export type AuthProvider = 'oauth2' | 'cas' | 'wecom';

/** 品牌默认值：与 tailwind.config.ts 的 brand 主色、登录页既有文案保持一致 */
const DEFAULT_LOGIN_TITLE = '登录 MaaS工作台';
const DEFAULT_BRAND_COLOR = '#2557D6';

/** 只为注入方便：测试里传字面量对象，不要求补齐 ProcessEnv 的 NODE_ENV */
export type EnvSource = Record<string, string | undefined>;

/**
 * 身份字段映射：值是 userinfo 里的字段路径（支持 `data.user_id` 这种级联写法），
 * 外部用户 ID 额外支持 `{school_id}:{user_id}` 模板。留空表示用内置兼容别名。
 */
export type OAuth2FieldMap = {
  /** 外部用户 ID，写进网关 external_user_id；上线后不可再改 */
  subject: string;
  email: string;
  name: string;
  schoolCode: string;
  schoolName: string;
  /** 角色字段，支持数组 / 逗号分隔字符串 */
  roles: string;
};

/** 通用登录限制：开关 + 条件列表；条件之间是「且」，全部满足才放行 */
export type AuthRestrictConfig = {
  /** 关闭时不限制任何账号 */
  enabled: boolean;
  /** 每条条件指定一个字段与必须命中的取值（trim + 小写后比较） */
  conditions: RestrictCondition[];
};

/** 引导期账号密码登录的强制开关：auto 按「SSO 是否配齐」自动判定 */
export type LocalAdminLoginMode = 'auto' | 'on' | 'off';

/**
 * 引导期管理员账号（只来自环境变量）。
 *
 * 用途只有一个：学校 SSO 还没对接完成时，能让运维登进 `/settings` 把 SSO 配好。
 * 一旦当前协议的必填项齐全，`passwordLoginState()` 会把它关掉（见 `auth/local-admin.ts`）。
 */
export type LocalAdminConfig = {
  username: string;
  password: string;
  mode: LocalAdminLoginMode;
};

/**
 * 标准 OAuth2 授权码参数（与厂商/门户无关）。
 *
 * 三个端点都由学校/IdP 提供：授权 → 回调 code → token 端点换 access_token →
 * 用户信息端点读身份。token 端点的认证方式与 userinfo 的 token 携带方式可配，
 * 用于兼容不同的 IdP 实现。
 */
export type OAuth2AuthConfig = {
  /** 认证授权端点 URL */
  authorizationEndpoint: string;
  /** Token 端点 URL */
  tokenEndpoint: string;
  /** 用户信息端点 URL */
  userInfoEndpoint: string;
  clientId: string;
  /** 只在服务端使用，绝不下发浏览器 */
  clientSecret: string;
  /** 授权范围，空格分隔，例如 `openid profile email` */
  scopes: string;
  /** token 端点校验客户端身份的方式 */
  tokenAuthMethod: 'client_secret_basic' | 'client_secret_post';
  /** userinfo 携带 access_token 的方式 */
  userInfoTokenCarrier: 'header' | 'query';
  /** 身份字段映射；各项留空时回退内置兼容别名 */
  fieldMap: OAuth2FieldMap;
};

/**
 * 标准 CAS 参数（直接对接学校 CAS Server，不经任何中间门户）。
 *
 * 发起登录跳 `loginUrl?service=<回调>`，CAS Server 带 `ticket` 回跳，
 * 门户拿 ticket 到 `ticketValidateUrl` 校验并读回身份属性。
 */
export type CasAuthConfig = {
  /** CAS 认证 URL */
  loginUrl: string;
  /** CAS Ticket 校验 URL */
  ticketValidateUrl: string;
};

/** 企业微信自建应用参数；Secret 只在服务端使用，绝不下发浏览器 */
export type WecomAuthConfig = {
  corpId: string;
  agentId: string;
  secret: string;
  /** 网页授权范围；未配置时回落 snsapi_base */
  scope: WecomScope;
};

export type AppConfig = {
  octafuse: {
    adminBase: string;
    proxyBase: string;
    adminUsername: string;
    adminPassword: string;
    externalSystem: string;
  };
  defaults: {
    budgetMax: number;
    budgetPeriod: string;
    /** 开户默认限流；null = 不限（不建窗口，也不发 rate_limit） */
    rateLimitRpm: number | null;
    rateLimitTpm: number | null;
  };
  auth: {
    provider: AuthProvider;
    sessionSecret: string;
    sessionTtlHours: number;
    cookieSecure: boolean;
    /** 标准 OAuth2 授权码参数 */
    oauth2: OAuth2AuthConfig;
    cas: CasAuthConfig;
    /** 企业微信自建应用参数 */
    wecom: WecomAuthConfig;
    /** 通用登录限制：不使用固定学校/角色名单，按配置字段决定谁能登录 */
    restrict: AuthRestrictConfig;
    /**
     * 角色自动同步为管理员：登录用户角色命中任一值（忽略大小写）时加入管理员名单。
     * 只增不删；空数组表示关闭。
     */
    adminRoles: string[];
  };
  portal: {
    /**
     * 侧边栏校名的**兜底值**，例如「演示学校」。
     * 登录时认证方返回了 `school_name` 就用真实校名；只有拿不到时才用这里，
     * 留空回退到「学校」，避免设计稿里的示例校名被带到线上。
     */
    schoolName: string;
    /**
     * Cookie 作用域。默认 `host-only`（不写 Domain）：同域部署最安全，
     * 不会漏到任何子域。只有两站分属不同子域、需要互认时才设父域（如 `.school.edu.cn`）。
     */
    cookieDomain: string;
    /**
     * Cookie 路径。默认 `/`。
     *
     * **同域多服务部署时必须收窄**：`/` 会让同域名下所有路径的服务都收到 `portal_session`。
     * 两站挂在 `/tokenhub` 下时设为 `/tokenhub` —— 既把作用域收到门户这一段，
     * 又保证 `/tokenhub/portal` 与 `/tokenhub/member` 共享同一个 Cookie（互认的前提）。
     * 注意不能设成各自的 basePath，那样两站各存一份，互认就断了。
     */
    cookiePath: string;
    /** 登录页与页脚文案（运行期配置，见 `src/lib/config/fields.ts`） */
    loginTitle: string;
    loginSubtitle: string;
    footerContact: string;
    /** 主色；默认与 tailwind 的 brand 主色一致 */
    brandColor: string;
    /** Logo 的 base64 data URL；为空时用内置字标 */
    logo: string;
    /**
     * 对外访问根地址，例如 https://ai.school.edu.cn。
     * 配置后所有 302 与同源校验都只认它，不再从请求头推导；
     * 留空则回退到 Host 头（仅本地开发可用，线上必须配）。
     */
    publicBaseUrl: string;
    /**
     * 管理台对外地址（如 https://host/tokenhub/admin）。
     * 登录回跳（`dest=admin`）只认它；留空时回调返回可读错误页，
     * 不回落到容器内网地址（浏览器打不开）。
     */
    adminPublicBaseUrl: string;
    /**
     * 成员自购站的公网基址（含 basePath，如 https://host/tokenhub/member）。
     * 仅同时部署两站时配置；留空时侧边栏不显示「成员账号」跳转入口。
     */
    memberPublicBaseUrl: string;
    /** 引导期管理员账号（仅 env）：SSO 未配齐时的唯一登录入口 */
    localAdmin: LocalAdminConfig;
  };
};

function required(env: EnvSource, key: string): string {
  const value = env[key];
  if (!value || !value.trim()) {
    throw new Error(`缺少必需的环境变量 ${key}`);
  }
  return value.trim();
}

function optional(env: EnvSource, key: string, fallback = ''): string {
  const value = env[key];
  return value && value.trim() ? value.trim() : fallback;
}

/** ── 网关管理员口令强度 ───────────────────────────────────────────────
 * 网关管理台能列出全站用户、读 API Key 明文、改供应商 Key，是整条链路的最高权限。
 * .env.example 里的 `change-me`、compose 早期的 `octafuse123` 在开源后就是公开信息，
 * 照抄即等于把管理台交出去，因此这里与 SESSION_SECRET 同口径在启动期直接拒绝。
 */
const GATEWAY_ADMIN_PASSWORD_MIN = 16;
/** 示例值 / 常见弱口令：整串匹配（小写比较） */
const GATEWAY_ADMIN_EXAMPLE_EXACT = new Set([
  'change-me',
  'change_me',
  'changeme',
  'octafuse123',
  'replace-me',
  'password',
  'passw0rd',
  'please-change',
  'admin',
  'secret',
  '123456',
  '12345678',
]);
/** 示例值前缀：`.env.example` 习惯用这些前缀提示「请替换」 */
const GATEWAY_ADMIN_EXAMPLE_PREFIX = /^(please-change|your-|replace-|example)/i;

/**
 * 校验网关管理员口令，返回去掉首尾空白的值。
 *
 * 只拦「明显会被公开猜到」的口令，不做复杂度策略：长度 + 示例值 + 字符种类下限，
 * 误伤真实口令比漏拦更糟（会把线上部署挡在启动之外）。
 */
export function assertGatewayAdminPassword(value: string, username = 'admin'): string {
  const password = value.trim();
  const hint = '请改用随机口令（openssl rand -base64 24）';
  // 先判示例值：`change-me` 这类串同时也不够长，但真正的问题是「它写在公开的示例文件里」，
  // 报错必须说清这一点，否则运维只会去补长度
  const lowered = password.toLowerCase();
  if (GATEWAY_ADMIN_EXAMPLE_EXACT.has(lowered) || GATEWAY_ADMIN_EXAMPLE_PREFIX.test(password)) {
    throw new Error(
      `OCTAFUSE_ADMIN_PASSWORD 仍是示例口令（如 change-me / octafuse123），开源后等于公开口令；${hint}`
    );
  }
  if (password.length < GATEWAY_ADMIN_PASSWORD_MIN) {
    throw new Error(
      `OCTAFUSE_ADMIN_PASSWORD 至少 ${GATEWAY_ADMIN_PASSWORD_MIN} 个字符（当前 ${password.length} 个）；${hint}`
    );
  }
  if (username.trim() && lowered === username.trim().toLowerCase()) {
    throw new Error(`OCTAFUSE_ADMIN_PASSWORD 不能与 OCTAFUSE_ADMIN_USERNAME 相同；${hint}`);
  }
  // 长度够但字符种类极少（`kkkk…`、`abcdabcd…`）同样是弱口令：8 种以上字符才不会一眼猜中
  const alphabet = new Set(password).size;
  if (alphabet < 8) {
    throw new Error(
      `OCTAFUSE_ADMIN_PASSWORD 字符种类过少（只有 ${alphabet} 种）：口令空间太小，易被在线爆破；${hint}`
    );
  }
  return password;
}

function assertUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`环境变量 ${name} 不是合法 URL：${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`环境变量 ${name} 必须是 http/https：${value}`);
  }
  return value.replace(/\/+$/, '');
}

/** 引导期账号密码登录：口令长度下限与示例值黑名单（与 SESSION_SECRET 同口径） */
const LOCAL_ADMIN_PASSWORD_MIN = 12;
const LOCAL_ADMIN_EXAMPLE_PATTERN = /^(please-change|change-me|your-|replace-|example)/i;
const LOCAL_ADMIN_MODES: readonly LocalAdminLoginMode[] = ['auto', 'on', 'off'];

/**
 * 读取引导期管理员账号。
 *
 * fail-closed：只配用户名或只配口令时，整组按「未配置」处理，并告警说明原因——
 * 少一半凭据的配置只会让人以为能登录，实际谁都登不进去。
 */
function parseLocalAdmin(env: EnvSource): LocalAdminConfig {
  const username = optional(env, 'PORTAL_ADMIN_USERNAME');
  const password = optional(env, 'PORTAL_ADMIN_PASSWORD');
  const rawMode = optional(env, 'PORTAL_ADMIN_LOGIN', 'auto').toLowerCase();
  const mode: LocalAdminLoginMode = (LOCAL_ADMIN_MODES as readonly string[]).includes(rawMode)
    ? (rawMode as LocalAdminLoginMode)
    : 'auto';
  if (mode !== rawMode) {
    console.warn(`[config] PORTAL_ADMIN_LOGIN 只能是 auto / on / off，当前是 ${rawMode}，按 auto 处理`);
  }

  if (!username && !password) return { username: '', password: '', mode };
  if (!username || !password) {
    console.warn(
      '[config] PORTAL_ADMIN_USERNAME 与 PORTAL_ADMIN_PASSWORD 必须同时配置；' +
        '当前只配了一项，引导期账号密码登录已禁用'
    );
    return { username: '', password: '', mode };
  }
  if (password.length < LOCAL_ADMIN_PASSWORD_MIN) {
    throw new Error(`PORTAL_ADMIN_PASSWORD 至少 ${LOCAL_ADMIN_PASSWORD_MIN} 个字符`);
  }
  if (LOCAL_ADMIN_EXAMPLE_PATTERN.test(password)) {
    throw new Error('PORTAL_ADMIN_PASSWORD 仍是示例口令（如 change-me），必须换成随机口令');
  }
  return { username, password, mode };
}

/**
 * Cookie path 归一：必须以 `/` 开头、不能以 `/` 结尾（除根路径）。
 * 非法值直接回落 `/` 而不是抛错——Cookie 配错会让所有人登录不上，不值得阻断启动。
 */
function normalizeCookiePath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('/')) return '/';
  const trimmed = value.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function loadConfig(env: EnvSource = process.env): AppConfig {
  // 登录协议只由数据库配置（设置页）决定：base 固定 oauth2，overlay 加载后覆盖。
  // 这里不再读 AUTH_PROVIDER，也不再因「显式选了协议」而强校验必填项——
  // 未对接 SSO 的部署必须能正常启动，否则无法进入设置页完成配置。
  const provider: AuthProvider = 'oauth2';

  const sessionSecret = required(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET 至少 32 个字符');
  }
  // 照抄 .env.example 里的公开示例串上线 = 任何人都能离线伪造任意会话，启动即拒绝。
  if (/^(please-change|change-me|your-|replace-|example)/i.test(sessionSecret) ||
      sessionSecret === 'please-change-this-to-a-random-32-char-secret') {
    throw new Error('SESSION_SECRET 仍是 .env.example 里的示例值，必须换成随机密钥');
  }
  // 长度够但字符种类极少（`kkkk…`、`abcdabcd…`）同样是弱密钥：HS256 的密钥空间只剩几种可能，
  // 离线暴力几秒就能还原出签名密钥，等价于没有校验。随机串（base64/hex）至少有 16 种以上字符，
  // 这里只拦明显退化的值，不误伤人肉输入的口令式密钥。
  const secretAlphabet = new Set(sessionSecret).size;
  if (secretAlphabet < 8) {
    throw new Error(
      `SESSION_SECRET 熵过低（只有 ${secretAlphabet} 种字符）：HS256 会话可被离线暴力还原，` +
        '请改用随机串（openssl rand -base64 48）'
    );
  }

  // 开户默认额度只由数据库配置（设置页）；base 用 20 兜底，overlay 加载后覆盖。
  const budgetMax = 20;

  const sessionTtlHours = Number(optional(env, 'SESSION_TTL_HOURS', '8'));
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0) {
    throw new Error('SESSION_TTL_HOURS 必须是正数');
  }

  const publicBaseUrlRaw = optional(env, 'PUBLIC_BASE_URL');
  const publicBaseUrl = publicBaseUrlRaw ? assertUrl('PUBLIC_BASE_URL', publicBaseUrlRaw) : '';

  // 对外地址是 https 时强制 Secure Cookie：漏配 COOKIE_SECURE 会让会话 Cookie 走明文。
  const cookieSecure =
    optional(env, 'COOKIE_SECURE', 'false') === 'true' || publicBaseUrl.startsWith('https://');

  // OAuth2 端点与凭证、协议细节全部只从数据库读；base 用协议默认值，overlay 加载后覆盖。
  const auth: AppConfig['auth'] = {
    provider,
    sessionSecret,
    sessionTtlHours,
    cookieSecure,
    oauth2: {
      authorizationEndpoint: '',
      tokenEndpoint: '',
      userInfoEndpoint: '',
      clientId: '',
      clientSecret: '',
      scopes: 'openid profile email',
      tokenAuthMethod: 'client_secret_basic',
      userInfoTokenCarrier: 'header',
      // 字段映射只走配置表（设置页），不提供环境变量，避免又回落到 .env
      fieldMap: {
        subject: '',
        email: '',
        name: '',
        schoolCode: '',
        schoolName: '',
        roles: '',
      },
    },
    cas: {
      loginUrl: '',
      ticketValidateUrl: '',
    },
    // 企微参数只走配置表；base 用安全默认值，overlay 加载后覆盖
    wecom: {
      corpId: '',
      agentId: '',
      secret: '',
      scope: DEFAULT_WECOM_SCOPE,
    },
    // 登录限制同样只走配置表；默认关闭 = 不限制
    restrict: {
      enabled: false,
      conditions: [],
    },
    // 角色自动同步管理员同样只走配置表；默认空 = 关闭
    adminRoles: [],
  };

  // SSO 参数（端点 / Client ID / Secret / CAS 地址）只在设置页维护，存 `portal_shared.login_config`。
  // 启动期不再对它们做必填校验：全新部署的库是空的，必须先能起来才能进设置页配置。
  // 最终生效值由 overlay 覆盖后交给 auth-validate 判定（见 instrumentation）。

  const adminPublicBaseUrlRaw = optional(env, 'ADMIN_PUBLIC_BASE_URL');
  const adminPublicBaseUrl = adminPublicBaseUrlRaw
    ? assertUrl('ADMIN_PUBLIC_BASE_URL', adminPublicBaseUrlRaw)
    : '';

  const memberPublicBaseUrlRaw = optional(env, 'MEMBER_PUBLIC_BASE_URL');
  const memberPublicBaseUrl = memberPublicBaseUrlRaw
    ? assertUrl('MEMBER_PUBLIC_BASE_URL', memberPublicBaseUrlRaw)
    : '';

  const localAdmin = parseLocalAdmin(env);

  // 这里**不能**根据 `localAdmin.mode` 打印「是否允许账号密码登录」的结论：
  // 本函数只产出 env 层的初值，最终生效值要等 overlay 用数据库的 `local_admin_mode`
  // 覆盖之后才知道（见 `config/overlay.ts` 的 applyLocalAdminField）。
  // 曾经在这里打印「PORTAL_ADMIN_LOGIN=on：允许账号密码登录」，而库里是 off，
  // 日志说「允许」、实际「关闭」，把排障的人带偏过。
  // 真实状态的提示统一放在 instrumentation 里（那里拿到的是 overlay 之后的 cfg）。

  // 网关管理员是最高权限：口令强度必须在这里拦住，不能等被人拿公开默认值登进管理台
  const octafuseAdminUsername = required(env, 'OCTAFUSE_ADMIN_USERNAME');
  const octafuseAdminPassword = assertGatewayAdminPassword(
    required(env, 'OCTAFUSE_ADMIN_PASSWORD'),
    octafuseAdminUsername
  );

  return {
    octafuse: {
      adminBase: assertUrl('OCTAFUSE_ADMIN_BASE', required(env, 'OCTAFUSE_ADMIN_BASE')),
      proxyBase: assertUrl('OCTAFUSE_PROXY_BASE', required(env, 'OCTAFUSE_PROXY_BASE')),
      adminUsername: octafuseAdminUsername,
      adminPassword: octafuseAdminPassword,
      externalSystem: required(env, 'OCTAFUSE_EXTERNAL_SYSTEM'),
    },
    defaults: {
      // 开户默认额度 / 周期 / 限流都只由数据库配置；base 用安全默认值，overlay 加载后覆盖。
      budgetMax,
      budgetPeriod: 'monthly',
      // 开户默认限流：base 用 rpm 50 / tpm 500000 兜底，overlay 加载后覆盖。
      rateLimitRpm: 50,
      rateLimitTpm: 500000,
    },
    auth,
    portal: {
      // 校名只由数据库配置；base 用「学校」兜底，overlay 加载后覆盖
      schoolName: '学校',
      cookieDomain: optional(env, 'PORTAL_COOKIE_DOMAIN', '').trim().replace(/^\.+/, '.'),
      cookiePath: normalizeCookiePath(optional(env, 'PORTAL_COOKIE_PATH', '/')),

      loginTitle: DEFAULT_LOGIN_TITLE,
      loginSubtitle: '',
      footerContact: '',
      brandColor: DEFAULT_BRAND_COLOR,
      logo: '',
      publicBaseUrl,
      adminPublicBaseUrl,
      memberPublicBaseUrl,
      localAdmin,
    },
  };
}

let cachedBase: AppConfig | null = null;
let cachedMerged: { revision: number; config: AppConfig } | null = null;

/**
 * 只读 env 的配置快照（不含数据库 overlay）。
 *
 * 给 middleware 这类「每个请求都跑、且不该访问数据库」的场景用：
 * middleware 只关心 PUBLIC_BASE_URL 与 CSP 里的代理地址，这两项本来就不来自配置表。
 */
export function getBaseConfig(): AppConfig {
  if (!cachedBase) cachedBase = loadConfig();
  return cachedBase;
}

/**
 * 进程内单例：env 解析一次，运行期配置（DB overlay）按快照叠加。
 *
 * overlay 未加载时等价于只用 env（与改造前行为一致）；
 * 快照变化（加载/失效）后重新合并，不需要重启进程。
 */
export function getConfig(): AppConfig {
  if (!cachedBase) cachedBase = loadConfig();
  const snapshot = getOverlaySnapshot();
  if (cachedMerged && cachedMerged.revision === snapshot.revision) return cachedMerged.config;

  const merged = applyOverlay(cachedBase, snapshot.stored ?? emptyOverlayStored());
  cachedMerged = { revision: snapshot.revision, config: merged };
  return merged;
}

/** 仅测试用：清掉缓存以便换一套 env 重新解析（同时清掉 overlay，避免用例互相污染）。 */
export function resetConfigCache(): void {
  cachedBase = null;
  cachedMerged = null;
  resetOverlayForTests();
}

/** 浏览器侧直连网关的地址；不在服务端配置里，单独读 public 变量。 */
export function getPublicProxyBase(): string {
  return (process.env.NEXT_PUBLIC_PROXY_BASE ?? '').replace(/\/+$/, '');
}
