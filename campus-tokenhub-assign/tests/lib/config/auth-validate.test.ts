import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, loadConfig, resetConfigCache, type AppConfig } from '@/lib/config';
import {
  ensureConfigOverlayLoaded,
  getOverlaySnapshot,
  refreshConfigOverlay,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';
import type { ConfigField, ConfigValue } from '@/lib/config/fields';
import type { StoredConfig } from '@/lib/config/store';
import { storedConfig } from '../../helpers/config';
import {
  assertAuthSafe,
  decideStartupAuth,
  isSsoConfigured,
  mergeDraftAuth,
  requiredSsoFields,
  validateAuthSection,
  validateAuthSectionErrors,
} from '@/lib/config/auth-validate';
import { getAuthAdapter } from '@/lib/auth/providers/registry';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'admin-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'auth-validate-test-session-secret-32-chars',
};

/** 模拟「设置页已配齐」：运行期配置只存数据库，测试用配置覆盖而不是 env */
const READY_OAUTH2 = {
  authorizationEndpoint: 'https://env-idp.example.com/oauth2/authorize',
  tokenEndpoint: 'https://env-idp.example.com/oauth2/token',
  userInfoEndpoint: 'https://env-idp.example.com/oauth2/userinfo',
  clientId: 'env-client-id',
  clientSecret: 'env-client-secret',
};

const READY_CAS = {
  loginUrl: 'https://env-cas.example.com/cas/login',
  ticketValidateUrl: 'https://env-cas.example.com/cas/serviceValidate',
};

const original = { ...process.env };

function overlay(values: Partial<Record<ConfigField, ConfigValue>>): StoredConfig {
  return storedConfig(values);
}

function loadBase(extra: Record<string, string> = {}): AppConfig {
  const base = loadConfig({ ...BASE_ENV, ...extra });
  return {
    ...base,
    auth: {
      ...base.auth,
      oauth2: { ...base.auth.oauth2, ...READY_OAUTH2 },
      cas: { ...base.auth.cas, ...READY_CAS },
    },
  };
}

/** 构造一个「DB 覆盖为非法协议」的运行时配置，绕过 loadConfig 的 env 层拒绝 */
function invalidConfig(base: AppConfig = loadBase()): AppConfig {
  return { ...base, auth: { ...base.auth, provider: 'wechat' as AppConfig['auth']['provider'] } };
}

beforeEach(() => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetOverlayForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

describe('validateAuthSection', () => {
  it('provider 非法时报错', () => {
    const errors = validateAuthSection(invalidConfig().auth, 'production');
    expect(errors.join('；')).toMatch(/oauth2|cas/);
  });

  it('oauth2 必填项缺失与非法 URL 都报错', () => {
    const base = loadBase();
    const missing = validateAuthSection(
      {
        ...base.auth,
        oauth2: {
          ...base.auth.oauth2,
          authorizationEndpoint: '',
          tokenEndpoint: '',
          userInfoEndpoint: '',
          clientId: '',
          clientSecret: '',
        },
      },
      'production'
    );
    expect(missing.length).toBeGreaterThanOrEqual(5);

    const invalidUrl = validateAuthSection(
      { ...base.auth, oauth2: { ...base.auth.oauth2, authorizationEndpoint: 'not-a-url' } },
      'production'
    );
    expect(invalidUrl.length).toBeGreaterThan(0);
  });

  it('cas 必填项缺失时报错', () => {
    const base = loadBase();
    const cas = validateAuthSection(
      {
        ...base.auth,
        provider: 'cas',
        cas: { ...base.auth.cas, loginUrl: '', ticketValidateUrl: '' },
      },
      'production'
    );
    expect(cas.length).toBeGreaterThanOrEqual(2);
  });

  it('合法 oauth2 / cas 无错误', () => {
    expect(validateAuthSection(loadBase().auth, 'production')).toEqual([]);
    const cas = loadBase();
    expect(
      validateAuthSection({ ...cas.auth, provider: 'cas' }, 'production')
    ).toEqual([]);
  });

  it('登录限制启用后必须填至少一条完整条件', () => {
    const base = loadBase();

    const missingCustom = validateAuthSectionErrors(
      {
        ...base.auth,
        restrict: {
          enabled: true,
          conditions: [{ field: 'custom', path: '  ', value: '100051' }],
        },
      },
      'production'
    );
    expect(missingCustom.map((error) => error.key)).toContain('restrictConditions');

    const missingConditions = validateAuthSectionErrors(
      {
        ...base.auth,
        restrict: { enabled: true, conditions: [] },
      },
      'production'
    );
    expect(missingConditions.map((error) => error.key)).toContain('restrictConditions');

    const missingValue = validateAuthSectionErrors(
      {
        ...base.auth,
        restrict: {
          enabled: true,
          conditions: [{ field: 'schoolCode', path: '', value: '   ' }],
        },
      },
      'production'
    );
    expect(missingValue.map((error) => error.key)).toContain('restrictConditions');

    expect(
      validateAuthSectionErrors(
        {
          ...base.auth,
          restrict: {
            enabled: true,
            conditions: [
              { field: 'schoolCode', path: '', value: '100051' },
              { field: 'roles', path: '', value: '老师' },
            ],
          },
        },
        'production'
      )
    ).toEqual([]);
  });

  it('nodeEnv 由调用方显式传入（不读全局）', () => {
    const auth = loadBase().auth;
    vi.stubEnv('NODE_ENV', 'development');
    expect(validateAuthSection(auth, 'production')).toEqual([]);
  });
});

describe('assertAuthSafe（O(1) 认证决策守卫）', () => {
  it('非法协议抛错并给出可读原因', () => {
    expect(() => assertAuthSafe(invalidConfig().auth, 'production')).toThrow(/SSO 协议/);
  });

  it('合法协议不抛错', () => {
    expect(() => assertAuthSafe(loadBase().auth, 'production')).not.toThrow();
  });
});

describe('认证决策守卫接入 getAuthAdapter', () => {
  it('CRITICAL：非法协议在写库前就被字段校验拒绝，不会变成生效配置', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    setOverlayLoader(async () => overlay({}));
    await refreshConfigOverlay();

    expect(getOverlaySnapshot().stored?.login.provider).toBeNull();
    expect(() => getConfig()).not.toThrow();
    expect(getConfig().auth.provider).toBe('oauth2');
    expect(getAuthAdapter().kind).toBe('oauth2');
  });

  it('CRITICAL fail-closed 时序：overlay 晚到也不会把非法协议带入决策', async () => {
    // 首帧：无 overlay，合法 oauth2
    expect(getAuthAdapter().kind).toBe('oauth2');

    setOverlayLoader(async () => overlay({}));
    await refreshConfigOverlay();

    expect(getOverlaySnapshot().stored?.login.provider).toBeNull();
    expect(getAuthAdapter().kind).toBe('oauth2');
  });

  it('显式传入 cfg 也触发守卫（默认参数不是唯一入口）', () => {
    expect(() => getAuthAdapter(invalidConfig())).toThrow(/SSO 协议/);
  });
});

describe('启动层语义（两类 false + true 后完整校验）', () => {
  it('DB 不可达/超时返回 false（启动层放行但 warn，不误杀）', async () => {
    setOverlayLoader(() => new Promise<StoredConfig>(() => undefined));
    expect(await ensureConfigOverlayLoaded(10)).toBe(false);
  });

  it('overlay 已加载且未注入非法协议，最终配置仍合法', async () => {
    // 运行期配置只存数据库：SSO 参数由 overlay 提供
    setOverlayLoader(async () =>
      overlay({
        oauth2AuthorizationEndpoint: 'https://env-idp.example.com/oauth2/authorize',
        oauth2TokenEndpoint: 'https://env-idp.example.com/oauth2/token',
        oauth2UserInfoEndpoint: 'https://env-idp.example.com/oauth2/userinfo',
        oauth2ClientId: 'env-client-id',
        oauth2ClientSecret: 'env-client-secret',
      })
    );
    expect(await ensureConfigOverlayLoaded(1000)).toBe(true);
    expect(getConfig().auth.provider).toBe('oauth2');
    expect(validateAuthSection(getConfig().auth, 'production')).toEqual([]);
  });
});

describe('mergeDraftAuth（草稿优先、未填项保留已存/env 值）', () => {
  it('草稿覆盖指定键，未提交的键保留 base', () => {
    const base = loadBase();
    const merged = mergeDraftAuth(base.auth, {
      'oauth2ClientId': 'draft-client',
      'provider': 'cas',
    });
    expect(merged.oauth2.clientId).toBe('draft-client');
    expect(merged.cas.loginUrl).toBe(base.auth.cas.loginUrl);
    expect(base.auth.oauth2.clientId).toBe('env-client-id');
  });

  it('改 oauth2 地址后用草稿值做校验（不误用已存值）', () => {
    const base = loadBase();
    const merged = mergeDraftAuth(base.auth, {
      'oauth2TokenEndpoint': 'not-a-url',
    });
    expect(validateAuthSection(merged, 'production').length).toBeGreaterThan(0);
  });

  it('切到 cas 时按草稿 cas 字段校验', () => {
    const base = loadBase();
    const merged = mergeDraftAuth(base.auth, {
      'provider': 'cas',
      'casLoginUrl': 'https://cas.example.com/login',
      'casTicketValidateUrl': 'https://cas.example.com/serviceValidate',
    });
    expect(merged.provider).toBe('cas');
    expect(validateAuthSection(merged, 'production')).toEqual([]);
  });

  it('草稿 provider 非法时校验拒绝且不落库（纯内存构造）', () => {
    const base = loadBase();
    const merged = mergeDraftAuth(base.auth, { 'provider': 'wechat' });
    expect(merged.provider).toBe('wechat');
    expect(validateAuthSection(merged, 'production').length).toBeGreaterThan(0);
    expect(base.auth.provider).toBe('oauth2');
  });
});

describe('decideStartupAuth（启动层三分支）', () => {  it('overlay 已加载 + 非法协议 → fail', () => {
    expect(
      decideStartupAuth({
        overlayLoaded: true,
        provider: 'wechat',
        nodeEnv: 'production',
      })
    ).toBe('fail');
  });

  it('DB 不可达/超时（未加载）+ 非法协议 → warn', () => {
    expect(
      decideStartupAuth({
        overlayLoaded: false,
        provider: 'wechat',
        nodeEnv: 'production',
      })
    ).toBe('warn');
  });

  it('合法协议 → ok', () => {
    for (const provider of ['oauth2', 'cas']) {
      expect(
        decideStartupAuth({
          overlayLoaded: true,
          provider,
          nodeEnv: 'production',
        })
      ).toBe('ok');
    }
  });
});

describe('mergeDraftAuth clearKeys（清空后回落到默认值）', () => {
  it('清空普通字段回落到空串', () => {
    const base = loadBase();
    const merged = mergeDraftAuth(base.auth, {}, ['oauth2ClientId']);
    expect(merged.oauth2.clientId).toBe('');
  });

  it('清空有协议默认值的字段回落到默认值', () => {
    const base = loadBase();
    const merged = mergeDraftAuth(base.auth, {}, ['oauth2Scopes']);
    expect(merged.oauth2.scopes).toBe('openid profile email');
  });

  it('结构化错误带字段 key', () => {
    const errors = validateAuthSectionErrors(invalidConfig().auth, 'production');
    expect(errors.some((error) => error.key === 'provider')).toBe(true);
  });
});

describe('requiredSsoFields / isSsoConfigured（账号密码登录的关闭判据）', () => {
  it('oauth2 返回五项，cas 返回两项，且 key 与设置页字段一致', () => {
    expect(requiredSsoFields(loadBase().auth).map((item) => item.key)).toEqual([
      'oauth2AuthorizationEndpoint',
      'oauth2TokenEndpoint',
      'oauth2UserInfoEndpoint',
      'oauth2ClientId',
      'oauth2ClientSecret',
    ]);

    const base = loadBase();
    expect(requiredSsoFields({ ...base.auth, provider: 'cas' }).map((item) => item.key)).toEqual([
      'casLoginUrl',
      'casTicketValidateUrl',
    ]);
  });

  it('必填项齐全才算已对接，缺 secret / 空白串都算未对接', () => {
    const base = loadBase();
    expect(isSsoConfigured(base.auth)).toBe(true);

    expect(
      isSsoConfigured({ ...base.auth, oauth2: { ...base.auth.oauth2, clientSecret: '' } })
    ).toBe(false);

    // 只填了空格的端点不能被判成已对接，否则会把唯一入口关掉
    expect(
      isSsoConfigured({ ...base.auth, oauth2: { ...base.auth.oauth2, tokenEndpoint: '   ' } })
    ).toBe(false);
  });

  it('按当前协议判定：oauth2 填满但协议切到 cas 且 cas 为空时仍未对接', () => {
    const base = loadBase();
    expect(
      isSsoConfigured({
        ...base.auth,
        provider: 'cas',
        cas: { loginUrl: '', ticketValidateUrl: '' },
      })
    ).toBe(false);

    expect(
      isSsoConfigured({
        ...base.auth,
        provider: 'cas',
        cas: {
          loginUrl: 'https://cas.example.com/login',
          ticketValidateUrl: 'https://cas.example.com/serviceValidate',
        },
      })
    ).toBe(true);
  });
});
