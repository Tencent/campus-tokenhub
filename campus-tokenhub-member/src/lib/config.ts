/**
 * 环境变量集中解析与校验。
 *
 * 只在这里读 `process.env`，其它模块一律从 `getConfig()` 拿，方便测试时注入。
 * 校验失败抛中文错误，直接暴露给运维看，不做二次包装。
 */

import { parsePermissionIds, toList } from './config/parse';
import { DEFAULT_WECOM_SCOPE, type RestrictCondition, type WecomScope } from './config/fields';
import {
  applyOverlay,
  emptyOverlayStored,
  getOverlaySnapshot,
  resetOverlayForTests,
} from './config/overlay';

/** SSO 协议：OAuth2（校内 AI 门户授权码）、CAS（学校统一认证）、企业微信（自建应用） */
export type AuthProvider = 'oauth2' | 'cas' | 'wecom';

/** 腾讯云组织接口的客户端实现：`tencent` 打真实接口，`mock` 仅用于本地与回归。 */
export type OrganizationProvider = 'tencent' | 'mock';

export type TencentCloudConfig = {
  /** CAM 子账号；留空时成员账号功能整体降级为「暂未开放」 */
  secretId: string;
  secretKey: string;
  /** organization 接口所在区域，文档标注该接口不需要 Region，传了不影响 */
  region: string;
  endpoint: string;
};

export type MemberAccountConfig = {
  provider: OrganizationProvider;
  /** 关系策略，腾讯云目前只支持 Financial */
  policyType: 'Financial';
  /** 财务权限 ID：1=查看账单、2=查看余额 必选 */
  permissionIds: number[];
};

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
  /** 成员站不写网关，但保留默认额度配置的展示能力（设置页仍可维护） */
  defaults: {
    budgetMax: number;
    budgetPeriod: string;
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
    /** 引导期管理员账号（仅 env）：SSO 未配齐时的唯一登录入口 */
    localAdmin: LocalAdminConfig;
  };
  tencentCloud: TencentCloudConfig;
  memberAccount: MemberAccountConfig;
  /** 成员账号申请单的落盘目录，容器里由命名卷挂载 */
  portalDataDir: string;
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

/** 可选的非负整数（开户默认限流）：未设置 / 空串 → null；非法值直接报错，避免静默变成「不限」。 */
function optionalRateLimit(env: EnvSource, key: string): number | null {
  const raw = env[key];
  const value = raw?.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${key} 必须是非负整数，或留空表示不限`);
  }
  return n;
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
  const rawProvider = optional(env, 'AUTH_PROVIDER', 'oauth2');
  // 未显式配置 AUTH_PROVIDER 时允许进程先起来，等配置中心 overlay 提供参数；
  // 一旦显式选择协议，就必须在启动期校验该协议的必填项，避免带着半成品登录配置运行。
  const providerExplicit = Boolean(optional(env, 'AUTH_PROVIDER'));
  // 旧部署的 AUTH_PROVIDER=aie 归一化为 oauth2（aie 本身就是 OAuth2），
  // 避免升级后现有环境启动失败；注册表与设置页只暴露 oauth2 / cas 两种。
  const provider: AuthProvider =
    rawProvider === 'aie' ? 'oauth2' : (rawProvider as AuthProvider);
  if (provider !== 'oauth2' && provider !== 'cas') {
    throw new Error(`AUTH_PROVIDER 只能是 oauth2 或 cas，当前是 ${rawProvider}`);
  }

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

  const sessionTtlHours = Number(optional(env, 'SESSION_TTL_HOURS', '8'));
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0) {
    throw new Error('SESSION_TTL_HOURS 必须是正数');
  }

  const publicBaseUrlRaw = optional(env, 'PUBLIC_BASE_URL');
  const publicBaseUrl = publicBaseUrlRaw ? assertUrl('PUBLIC_BASE_URL', publicBaseUrlRaw) : '';

  // 对外地址是 https 时强制 Secure Cookie：漏配 COOKIE_SECURE 会让会话 Cookie 走明文。
  const cookieSecure =
    optional(env, 'COOKIE_SECURE', 'false') === 'true' || publicBaseUrl.startsWith('https://');

  const memberProvider = optional(
    env,
    'MEMBER_ACCOUNT_PROVIDER',
    'tencent'
  ) as OrganizationProvider;
  if (memberProvider !== 'tencent' && memberProvider !== 'mock') {
    throw new Error(
      `MEMBER_ACCOUNT_PROVIDER 只能是 tencent 或 mock，当前是 ${memberProvider}`
    );
  }
  // mock 会在生产上「假装建号成功」，比演示登录更危险：老师以为账号开好了却根本没有。
  if (memberProvider === 'mock' && optional(env, 'NODE_ENV') === 'production') {
    throw new Error(
      '生产环境（NODE_ENV=production）不允许 MEMBER_ACCOUNT_PROVIDER=mock：' +
        '会在生产上假装建号成功，请改成 tencent'
    );
  }

  const policyType = optional(env, 'MEMBER_ACCOUNT_POLICY_TYPE', 'Financial');
  if (policyType !== 'Financial') {
    throw new Error(`MEMBER_ACCOUNT_POLICY_TYPE 只支持 Financial，当前是 ${policyType}`);
  }

  const tokenAuthMethodRaw = optional(env, 'OAUTH2_TOKEN_AUTH_METHOD', 'client_secret_basic');
  if (tokenAuthMethodRaw !== 'client_secret_basic' && tokenAuthMethodRaw !== 'client_secret_post') {
    throw new Error(
      `OAUTH2_TOKEN_AUTH_METHOD 只能是 client_secret_basic 或 client_secret_post，当前是 ${tokenAuthMethodRaw}`
    );
  }
  const userInfoTokenCarrierRaw = optional(env, 'OAUTH2_USERINFO_TOKEN_CARRIER', 'header');
  if (userInfoTokenCarrierRaw !== 'header' && userInfoTokenCarrierRaw !== 'query') {
    throw new Error(
      `OAUTH2_USERINFO_TOKEN_CARRIER 只能是 header 或 query，当前是 ${userInfoTokenCarrierRaw}`
    );
  }

  const budgetMax = Number(optional(env, 'DEFAULT_BUDGET_MAX', '100'));
  if (!Number.isFinite(budgetMax) || budgetMax <= 0) {
    throw new Error('DEFAULT_BUDGET_MAX 必须是正数');
  }

  const auth: AppConfig['auth'] = {
    provider,
    sessionSecret,
    sessionTtlHours,
    cookieSecure,
    oauth2: {
      authorizationEndpoint: optional(env, 'OAUTH2_AUTHORIZATION_ENDPOINT'),
      tokenEndpoint: optional(env, 'OAUTH2_TOKEN_ENDPOINT'),
      userInfoEndpoint: optional(env, 'OAUTH2_USERINFO_ENDPOINT'),
      clientId: optional(env, 'OAUTH2_CLIENT_ID'),
      clientSecret: optional(env, 'OAUTH2_CLIENT_SECRET'),
      scopes: optional(env, 'OAUTH2_SCOPES', 'openid profile email'),
      tokenAuthMethod: tokenAuthMethodRaw,
      userInfoTokenCarrier: userInfoTokenCarrierRaw,
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
      loginUrl: optional(env, 'CAS_LOGIN_URL'),
      ticketValidateUrl: optional(env, 'CAS_TICKET_VALIDATE_URL'),
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

  if (provider === 'oauth2') {
    if (providerExplicit) {
      for (const [label, value] of [
        ['OAUTH2_AUTHORIZATION_ENDPOINT', auth.oauth2.authorizationEndpoint],
        ['OAUTH2_TOKEN_ENDPOINT', auth.oauth2.tokenEndpoint],
        ['OAUTH2_USERINFO_ENDPOINT', auth.oauth2.userInfoEndpoint],
        ['OAUTH2_CLIENT_ID', auth.oauth2.clientId],
        ['OAUTH2_CLIENT_SECRET', auth.oauth2.clientSecret],
      ] as const) {
        if (!value) throw new Error(`AUTH_PROVIDER=oauth2 时必须提供 ${label}`);
      }
    }
    if (auth.oauth2.authorizationEndpoint) {
      auth.oauth2.authorizationEndpoint = assertUrl(
        'OAUTH2_AUTHORIZATION_ENDPOINT',
        auth.oauth2.authorizationEndpoint
      );
    }
    if (auth.oauth2.tokenEndpoint) {
      auth.oauth2.tokenEndpoint = assertUrl('OAUTH2_TOKEN_ENDPOINT', auth.oauth2.tokenEndpoint);
    }
    if (auth.oauth2.userInfoEndpoint) {
      auth.oauth2.userInfoEndpoint = assertUrl('OAUTH2_USERINFO_ENDPOINT', auth.oauth2.userInfoEndpoint);
    }
  }

  if (provider === 'cas') {
    if (providerExplicit) {
      for (const [label, value] of [
        ['CAS_LOGIN_URL', auth.cas.loginUrl],
        ['CAS_TICKET_VALIDATE_URL', auth.cas.ticketValidateUrl],
      ] as const) {
        if (!value) throw new Error(`AUTH_PROVIDER=cas 时必须提供 ${label}`);
      }
    }
    if (auth.cas.loginUrl) auth.cas.loginUrl = assertUrl('CAS_LOGIN_URL', auth.cas.loginUrl);
    if (auth.cas.ticketValidateUrl) {
      auth.cas.ticketValidateUrl = assertUrl('CAS_TICKET_VALIDATE_URL', auth.cas.ticketValidateUrl);
    }
  }

  const adminPublicBaseUrlRaw = optional(env, 'ADMIN_PUBLIC_BASE_URL');
  const adminPublicBaseUrl = adminPublicBaseUrlRaw
    ? assertUrl('ADMIN_PUBLIC_BASE_URL', adminPublicBaseUrlRaw)
    : '';

  const localAdmin = parseLocalAdmin(env);
  if (localAdmin.mode === 'on') {
    console.warn(
      '[config] PORTAL_ADMIN_LOGIN=on：即使学校 SSO 已配齐也允许账号密码登录，只应在救急时临时使用'
    );
  }

  return {
    defaults: {
      budgetMax,
      budgetPeriod: optional(env, 'DEFAULT_BUDGET_PERIOD', 'monthly'),
      rateLimitRpm: optionalRateLimit(env, 'DEFAULT_RATE_LIMIT_RPM'),
      rateLimitTpm: optionalRateLimit(env, 'DEFAULT_RATE_LIMIT_TPM'),
    },
    auth,
    portal: {
      schoolName: optional(env, 'PORTAL_SCHOOL_NAME', '学校'),
      cookieDomain: optional(env, 'PORTAL_COOKIE_DOMAIN', '').trim().replace(/^\.+/, '.'),
      cookiePath: normalizeCookiePath(optional(env, 'PORTAL_COOKIE_PATH', '/')),

      loginTitle: DEFAULT_LOGIN_TITLE,
      loginSubtitle: '',
      footerContact: '',
      brandColor: DEFAULT_BRAND_COLOR,
      logo: '',
      publicBaseUrl,
      adminPublicBaseUrl,
      localAdmin,
    },
    tencentCloud: {
      secretId: optional(env, 'TENCENTCLOUD_SECRET_ID'),
      secretKey: optional(env, 'TENCENTCLOUD_SECRET_KEY'),
      region: optional(env, 'TENCENTCLOUD_ORGANIZATION_REGION', 'ap-guangzhou'),
      endpoint: optional(
        env,
        'TENCENTCLOUD_ORGANIZATION_ENDPOINT',
        'organization.tencentcloudapi.com'
      ),
    },
    memberAccount: {
      provider: memberProvider,
      policyType: 'Financial',
      permissionIds: parsePermissionIds(optional(env, 'MEMBER_ACCOUNT_PERMISSION_IDS')),
    },
    portalDataDir: optional(env, 'PORTAL_DATA_DIR', './.data'),
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

