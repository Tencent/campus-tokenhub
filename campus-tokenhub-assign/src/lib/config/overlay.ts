/**
 * 配置 overlay：把数据库里的结构化配置叠到 env 基础配置上。
 *
 * 为什么不把 `getConfig()` 改成异步：认证、导航、middleware 全在同步路径上
 * （24 个文件调用 `getConfig()`），改 async 会连锁改到整个请求链路。
 * 这里用「env 快照 + 内存 overlay」：
 * - `applyOverlay` 是纯函数，按类型化字段显式赋值，方便单测；
 * - 快照 30 秒 TTL，写入后由调用方主动刷新；
 * - middleware 等非 nodejs 运行时直接短路，绝不发起数据库访问。
 */

import type { AppConfig } from '@/lib/config';
import type { StoredConfig } from './store';
import {
  LOGIN_FIELD_NAMES,
  emptyStoredValues,
  type ConfigField,
  type ConfigValue,
  type LoginField,
} from './fields';
import { setRuntimeSecretProvider } from './secrets';
import { toList } from './parse';

/** 多副本下最坏延迟：写入后其它实例最多这么久看到新值 */
export const OVERLAY_TTL_MS = 30_000;

export type OverlaySnapshot = {
  stored: StoredConfig | null;
  /** 敏感值明文，仅供日志脱敏使用 */
  secretPlaintexts: string[];
  /** 解密 / 解析失败的字段 */
  brokenFields: ConfigField[];
  /** 是否至少成功加载过一次 */
  loaded: boolean;
  /** 最近一次成功加载的时间戳；0 表示从未加载 */
  loadedAt: number;
  /** 单调递增的版本号：同一毫秒内多次刷新也能让缓存的合并结果失效 */
  revision: number;
};

const EMPTY_SNAPSHOT: OverlaySnapshot = {
  stored: null,
  secretPlaintexts: [],
  brokenFields: [],
  loaded: false,
  loadedAt: 0,
  revision: 0,
};

export type OverlayLoader = () => Promise<StoredConfig>;

let snapshot: OverlaySnapshot = EMPTY_SNAPSHOT;
let loader: OverlayLoader | null = null;
let inflight: Promise<void> | null = null;
/** 当前单飞令牌：用于「只清自己这一轮」，避免旧一轮结束时清掉新一轮的 inflight */
let inflightToken: object | null = null;
/** 测试/应急：关掉自动刷新后，只有显式 refresh 才会读库（resetConfigCache 会关掉） */
let autoRefresh = true;
/** 代次：reset / invalidate 后，旧的进行中刷新结果必须丢弃，否则会写回已清空的快照 */
let generation = 0;
/** 成功加载的版本号；用时间戳做缓存键会在同一毫秒内失效（实测踩过） */
let revision = 0;

/** 非 nodejs 运行时（middleware / edge）不做任何数据库访问 */
function isNodeRuntime(): boolean {
  const runtime = process.env.NEXT_RUNTIME;
  return !runtime || runtime === 'nodejs';
}

/** overlay 未加载时的空配置（无 pg 依赖，edge 运行时可用） */
export function emptyOverlayStored(): StoredConfig {
  return {
    ...emptyStoredValues(),
    verify: {
      currency: { group: 'currency', status: 'unverified', message: null, verifiedAt: null },
    },
    brokenFields: [],
    secretPlaintexts: [],
    updatedBy: null,
  };
}

/** DB 来源的 URL 型字段与 env 对齐：trim + 去尾斜杠，避免 issuer 精确匹配/路径拼接出错 */
function normalizeAuthUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** 深拷贝 auth：草稿校验要构造临时对象，不能改到共享的 getConfig() 结果 */
export function cloneAuth(auth: AppConfig['auth']): AppConfig['auth'] {
  return {
    ...auth,
    oauth2: { ...auth.oauth2, fieldMap: { ...auth.oauth2.fieldMap } },
    cas: { ...auth.cas },
    wecom: { ...auth.wecom },
    restrict: { ...auth.restrict, conditions: auth.restrict.conditions.map((item) => ({ ...item })) },
    adminRoles: [...auth.adminRoles],
  };
}

/** 按类型化字段读认证值：设置页回显与草稿校验共用，不再按字符串 key 查找 */
export function readLoginField(auth: AppConfig['auth'], field: LoginField): ConfigValue | undefined {
  switch (field) {
    case 'provider': return auth.provider;
    case 'oauth2AuthorizationEndpoint': return auth.oauth2.authorizationEndpoint;
    case 'oauth2TokenEndpoint': return auth.oauth2.tokenEndpoint;
    case 'oauth2UserInfoEndpoint': return auth.oauth2.userInfoEndpoint;
    case 'oauth2ClientId': return auth.oauth2.clientId;
    case 'oauth2ClientSecret': return auth.oauth2.clientSecret;
    case 'oauth2Scopes': return auth.oauth2.scopes;
    case 'oauth2TokenAuthMethod': return auth.oauth2.tokenAuthMethod;
    case 'oauth2UserInfoTokenCarrier': return auth.oauth2.userInfoTokenCarrier;
    case 'oauth2FieldMapSubject': return auth.oauth2.fieldMap.subject;
    case 'oauth2FieldMapEmail': return auth.oauth2.fieldMap.email;
    case 'oauth2FieldMapName': return auth.oauth2.fieldMap.name;
    case 'oauth2FieldMapSchoolCode': return auth.oauth2.fieldMap.schoolCode;
    case 'oauth2FieldMapSchoolName': return auth.oauth2.fieldMap.schoolName;
    case 'oauth2FieldMapRoles': return auth.oauth2.fieldMap.roles;
    case 'casLoginUrl': return auth.cas.loginUrl;
    case 'casTicketValidateUrl': return auth.cas.ticketValidateUrl;
    case 'wecomCorpId': return auth.wecom.corpId;
    case 'wecomAgentId': return auth.wecom.agentId;
    case 'wecomClientSecret': return auth.wecom.secret;
    case 'wecomScope': return auth.wecom.scope;
    case 'restrictEnabled': return auth.restrict.enabled;
    case 'restrictConditions': return auth.restrict.conditions;
    case 'adminRoles': return auth.adminRoles;
    default: return undefined;
  }
}

/** 按类型化字段写认证值：overlay 合并和草稿校验是同一套语义 */
export function applyLoginField(
  auth: AppConfig['auth'],
  field: LoginField,
  raw: ConfigValue
): void {
  const text = Array.isArray(raw) ? raw.map(String).join(',') : String(raw);
  switch (field) {
    case 'provider':
      auth.provider = text as AppConfig['auth']['provider'];
      return;
    case 'oauth2AuthorizationEndpoint':
      auth.oauth2.authorizationEndpoint = normalizeAuthUrl(text);
      return;
    case 'oauth2TokenEndpoint':
      auth.oauth2.tokenEndpoint = normalizeAuthUrl(text);
      return;
    case 'oauth2UserInfoEndpoint':
      auth.oauth2.userInfoEndpoint = normalizeAuthUrl(text);
      return;
    case 'oauth2ClientId':
      auth.oauth2.clientId = text;
      return;
    case 'oauth2ClientSecret':
      auth.oauth2.clientSecret = text;
      return;
    case 'oauth2Scopes':
      auth.oauth2.scopes = text;
      return;
    case 'oauth2TokenAuthMethod':
      auth.oauth2.tokenAuthMethod = text as AppConfig['auth']['oauth2']['tokenAuthMethod'];
      return;
    case 'oauth2UserInfoTokenCarrier':
      auth.oauth2.userInfoTokenCarrier = text as AppConfig['auth']['oauth2']['userInfoTokenCarrier'];
      return;
    case 'oauth2FieldMapSubject':
      auth.oauth2.fieldMap.subject = text;
      return;
    case 'oauth2FieldMapEmail':
      auth.oauth2.fieldMap.email = text;
      return;
    case 'oauth2FieldMapName':
      auth.oauth2.fieldMap.name = text;
      return;
    case 'oauth2FieldMapSchoolCode':
      auth.oauth2.fieldMap.schoolCode = text;
      return;
    case 'oauth2FieldMapSchoolName':
      auth.oauth2.fieldMap.schoolName = text;
      return;
    case 'oauth2FieldMapRoles':
      auth.oauth2.fieldMap.roles = text;
      return;
    case 'casLoginUrl':
      auth.cas.loginUrl = normalizeAuthUrl(text);
      return;
    case 'casTicketValidateUrl':
      auth.cas.ticketValidateUrl = normalizeAuthUrl(text);
      return;
    case 'wecomCorpId':
      auth.wecom.corpId = text;
      return;
    case 'wecomAgentId':
      auth.wecom.agentId = text;
      return;
    case 'wecomClientSecret':
      auth.wecom.secret = text;
      return;
    case 'wecomScope':
      auth.wecom.scope = text as AppConfig['auth']['wecom']['scope'];
      return;
    case 'restrictEnabled':
      auth.restrict.enabled = Boolean(raw);
      return;
    case 'restrictConditions':
      auth.restrict.conditions = Array.isArray(raw)
        ? raw.map((item) => ({ ...(item as AppConfig['auth']['restrict']['conditions'][number]) }))
        : [];
      return;
    case 'adminRoles':
      auth.adminRoles = [...new Set(toList(text))];
      return;
    default:
      return;
  }
}

/**
 * 把 overlay 叠到 base 上。纯函数：不修改入参，返回新对象。
 *
 * 逐字段显式赋值而不是深合并：配置结构里有数组与嵌套对象，
 * 深合并容易把「没配置」误判成「配置成空」。NULL 字段表示未配置，直接保留 base。
 */

/**
 * 部署管理员三个字段不属于 `auth`，而是 `portal.localAdmin`（引导期账号密码登录）。
 * 单独处理：混进 applyLoginField 会把它们写到一个不存在的 auth 子树上。
 */
function applyLocalAdminField(
  target: AppConfig['portal']['localAdmin'],
  field: 'localAdminMode' | 'localAdminUsername' | 'localAdminPassword',
  value: ConfigValue
): void {
  if (field === 'localAdminMode') {
    const text = String(value).toLowerCase();
    target.mode = (['auto', 'on', 'off'] as readonly string[]).includes(text)
      ? (text as AppConfig['portal']['localAdmin']['mode'])
      : 'auto';
    return;
  }
  if (field === 'localAdminUsername') {
    target.username = String(value).trim();
    return;
  }
  target.password = String(value);
}

export function applyOverlay(base: AppConfig, stored: StoredConfig): AppConfig {
  const portal = { ...base.portal, localAdmin: { ...base.portal.localAdmin } };
  const defaults = { ...base.defaults };
  const auth: AppConfig['auth'] = {
    ...base.auth,
    oauth2: { ...base.auth.oauth2, fieldMap: { ...base.auth.oauth2.fieldMap } },
    cas: { ...base.auth.cas },
    wecom: { ...base.auth.wecom },
    restrict: { ...base.auth.restrict, conditions: base.auth.restrict.conditions.map((item) => ({ ...item })) },
    adminRoles: [...base.auth.adminRoles],
  };

  const app = stored.app;
  if (app.schoolName !== null) portal.schoolName = app.schoolName;
  if (app.loginTitle !== null) portal.loginTitle = app.loginTitle;
  if (app.loginSubtitle !== null) portal.loginSubtitle = app.loginSubtitle;
  if (app.footerContact !== null) portal.footerContact = app.footerContact;
  if (app.brandColor !== null) portal.brandColor = app.brandColor;
  if (app.logo !== null) portal.logo = app.logo;
  if (app.defaultBudgetMax !== null) defaults.budgetMax = app.defaultBudgetMax;
  if (app.defaultBudgetPeriod !== null) defaults.budgetPeriod = app.defaultBudgetPeriod;
  if (app.defaultRateLimitRpm !== null) defaults.rateLimitRpm = app.defaultRateLimitRpm;
  if (app.defaultRateLimitTpm !== null) defaults.rateLimitTpm = app.defaultRateLimitTpm;

  for (const field of LOGIN_FIELD_NAMES) {
    const value = stored.login[field];
    if (value === null) continue;
    if (
      field === 'localAdminMode' ||
      field === 'localAdminUsername' ||
      field === 'localAdminPassword'
    ) {
      applyLocalAdminField(portal.localAdmin, field, value as ConfigValue);
      continue;
    }
    applyLoginField(auth, field, value as ConfigValue);
  }

  return { ...base, portal, defaults, auth };
}

export function setOverlayLoader(next: OverlayLoader | null): void {
  loader = next;
  inflight = null;
}

/**
 * 默认 loader：只在真正读库时才加载 pg / schema 模块。
 *
 * 必须动态 import：`config.ts` 被 `src/middleware.ts` 静态引用，
 * 若这里静态连到 `pg`，edge 运行时会因为 Node 内置模块不可用而整站 500。
 */
async function defaultLoader(): Promise<StoredConfig> {
  const [{ isPortalDbConfigured }, { ensurePortalSchema }, store] = await Promise.all([
    import('@/lib/db/portal-db'),
    import('@/lib/db/portal-schema'),
    import('./store'),
  ]);

  if (!store.hasConfigRepoOverride() && !isPortalDbConfigured()) {
    return emptyOverlayStored();
  }
  if (isPortalDbConfigured()) await ensurePortalSchema();
  return store.readStoredConfig();
}

/** 读库并更新快照。单飞：并发调用只跑一次；失败保留旧快照。 */
export async function refreshConfigOverlay(): Promise<void> {
  if (!isNodeRuntime()) return;
  if (inflight) return inflight;

  const startedAt = generation;
  const token = {};
  const run = (async () => {
    try {
      const stored = await (loader ?? defaultLoader)();
      if (startedAt !== generation) return;
      revision += 1;
      snapshot = {
        stored,
        secretPlaintexts: stored.secretPlaintexts,
        brokenFields: [...stored.brokenFields],
        loaded: true,
        loadedAt: Date.now(),
        revision,
      };
      setRuntimeSecretProvider(() => snapshot.secretPlaintexts);
    } catch (error) {
      console.warn(
        `[config] 读取运行期配置失败，继续使用环境变量：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (inflightToken === token) {
        inflight = null;
        inflightToken = null;
      }
    }
  })();

  inflight = run;
  inflightToken = token;
  return run;
}

/** 写配置后调用：清空快照，下一次 getConfig 立刻回落到 base 配置，随后刷新 */
export function invalidateConfigOverlay(): void {
  generation += 1;
  revision += 1;
  snapshot = { ...EMPTY_SNAPSHOT, revision };
  inflight = null;
}

/** 同步读取当前快照；过期时触发后台刷新但不阻塞本次调用 */
export function getOverlaySnapshot(): OverlaySnapshot {
  if (!isNodeRuntime()) return EMPTY_SNAPSHOT;

  if (!snapshot.loadedAt) {
    if (autoRefresh) void refreshConfigOverlay();
    return snapshot;
  }

  if (autoRefresh && Date.now() - snapshot.loadedAt > OVERLAY_TTL_MS) {
    void refreshConfigOverlay();
  }
  return snapshot;
}

export function readOverlayStatus(): OverlaySnapshot {
  return snapshot;
}

/**
 * 判定前等待一次加载（上限 1 秒）。
 *
 * 用于管理员判定：进程刚起 / 数据库晚于门户启动时，overlay 还没加载，
 * 直接判定会把管理员误判成非管理员。超时按「未加载」处理，不阻塞登录。
 */
export async function ensureConfigOverlayLoaded(timeoutMs = 1000): Promise<boolean> {
  if (!isNodeRuntime()) return false;
  if (readOverlayStatus().loaded) return true;

  await Promise.race([
    refreshConfigOverlay().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs).unref?.();
    }),
  ]);

  return readOverlayStatus().loaded;
}

/**
 * 页面渲染前的「等一次新鲜配置」。
 *
 * `getOverlaySnapshot()` 是同步的：快照过期时它只**发起**后台刷新，然后把**旧值**交出去。
 * 于是「保存完配置立刻打开页面」看到的还是旧状态——实测把「账号密码登录」改成 off 保存后：
 * 登录页仍然渲染出部署管理员表单（两个入口都在），设置页顶部的「登录方式」横幅也仍然提示 on，
 * 要等快照 TTL（30 秒）过期后再刷才变。接口路径没有这个问题，会立刻读到新值。
 *
 * 页面是给人做决定的，宁可多一次读库也不能拿旧值，所以这里**等**刷新完成再返回：
 * - `maxAgeMs = 0`（默认）：每次都读库，保证「保存完立刻看页面」是对的；
 * - 传大一点可以让 TTL 继续生效，给不关心实时性的页面用；
 * - 数据库不可用时 `refreshConfigOverlay` 自己吞错并保留旧快照，不会把页面拦死；
 *   默认 1.5 秒超时兜底，避免库卡住时把渲染挂在那里。
 *
 * 只给服务端页面调用；middleware 等非 nodejs 运行时直接短路，测试关掉 autoRefresh 时也不读库。
 */
export async function ensureConfigOverlayFresh(maxAgeMs = 0, timeoutMs = 1500): Promise<boolean> {
  if (!isNodeRuntime()) return false;
  const loadedAt = snapshot.loadedAt;
  // maxAgeMs <= 0 表示「每次都要读库」：不能写成 `Date.now() - loadedAt <= 0`，
  // 同一毫秒内刷过也会命中那个条件，等于什么都没刷（实测单测里必踩）。
  if (maxAgeMs > 0 && loadedAt && Date.now() - loadedAt <= maxAgeMs) return true;
  if (!autoRefresh) return Boolean(loadedAt);

  await Promise.race([
    refreshConfigOverlay().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs).unref?.();
    }),
  ]);

  return Boolean(readOverlayStatus().loadedAt);
}

/** 仅测试用：恢复初始状态（同时禁用自动刷新，避免用例之间互相打库） */
export function resetOverlayForTests(): void {
  generation += 1;
  snapshot = EMPTY_SNAPSHOT;
  loader = null;
  inflight = null;
  autoRefresh = false;
  setRuntimeSecretProvider(null);
}

/** 仅测试用：重新打开 TTL 自动刷新 */
export function enableOverlayAutoRefresh(): void {
  autoRefresh = true;
}

/** 仅测试用：关掉 TTL 自动刷新，只有显式 refresh 才读库 */
export function disableOverlayAutoRefresh(): void {
  autoRefresh = false;
}

/** 测试用：直接注入一份结构化配置，不经过数据库 */
export function setOverlayStoredForTests(stored: StoredConfig | null): void {
  snapshot = stored
    ? {
        stored,
        secretPlaintexts: stored.secretPlaintexts,
        brokenFields: [...stored.brokenFields],
        loaded: true,
        loadedAt: Date.now(),
        revision: ++revision,
      }
    : { ...EMPTY_SNAPSHOT, revision: ++revision };
}
