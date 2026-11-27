import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache, type AppConfig } from '@/lib/config';
import {
  applyLoginField,
  applyOverlay,
  cloneAuth,
  readLoginField,
  resetOverlayForTests,
  setOverlayStoredForTests,
} from '@/lib/config/overlay';
import {
  LOGIN_FIELD_NAMES,
  LOGIN_FIELDS,
  isConfigField,
  type ConfigValue,
  type LoginField,
} from '@/lib/config/fields';
import { getAuthAdapter } from '@/lib/auth/providers/registry';
import { storedConfig } from '../../helpers/config';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'admin-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'auth-registry-test-session-secret-32-chars',
  AUTH_PROVIDER: 'oauth2',
  OAUTH2_AUTHORIZATION_ENDPOINT: 'https://env-idp.example.com/oauth2/authorize',
  OAUTH2_TOKEN_ENDPOINT: 'https://env-idp.example.com/oauth2/token',
  OAUTH2_USERINFO_ENDPOINT: 'https://env-idp.example.com/oauth2/userinfo',
  OAUTH2_CLIENT_ID: 'env-client-id',
  OAUTH2_CLIENT_SECRET: 'env-client-secret',
  CAS_LOGIN_URL: 'https://env-cas.example.com/cas/login',
  CAS_TICKET_VALIDATE_URL: 'https://env-cas.example.com/cas/serviceValidate',
};

const original = { ...process.env };

function loadBase(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, ...extra });
}

beforeEach(() => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetOverlayForTests();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

describe('登录配置字段模型', () => {
  it('只声明标准 OAuth2 / CAS / 企业微信协议字段 + 字段映射 + 登录限制字段', () => {
    const required: LoginField[] = [
      'provider',
      'oauth2AuthorizationEndpoint',
      'oauth2TokenEndpoint',
      'oauth2UserInfoEndpoint',
      'oauth2ClientId',
      'oauth2ClientSecret',
      'oauth2Scopes',
      'oauth2TokenAuthMethod',
      'oauth2UserInfoTokenCarrier',
      'oauth2FieldMapSubject',
      'oauth2FieldMapEmail',
      'oauth2FieldMapName',
      'oauth2FieldMapSchoolCode',
      'oauth2FieldMapSchoolName',
      'oauth2FieldMapRoles',
      'adminRoles',
      'casLoginUrl',
      'casTicketValidateUrl',
      'wecomCorpId',
      'wecomAgentId',
      'wecomClientSecret',
      'wecomScope',
      'restrictEnabled',
      'restrictConditions',
      'localAdminMode',
      'localAdminUsername',
      'localAdminPassword',
    ];
    expect([...LOGIN_FIELD_NAMES].sort()).toEqual([...required].sort());
  });

  it('provider 只允许 oauth2 / cas / wecom，旧协议与硬编码名单字段都不存在', () => {
    expect(LOGIN_FIELDS.provider.enumValues).toEqual(['oauth2', 'cas', 'wecom']);
    for (const key of [
      'auth.oauth2.corpCode',
      'auth.cas.corpCode',
      'auth.oauth2.apiBase',
      'auth.oidc.issuer',
      'auth.allowedSchools',
      'auth.allowedRoles',
    ]) {
      expect(isConfigField(key), key).toBe(false);
    }
  });

  it('clientSecret 标记 secret，限制条件是多条「字段 + 取值」', () => {
    expect(LOGIN_FIELDS.oauth2ClientSecret.secret).toBe(true);
    expect(LOGIN_FIELDS.oauth2ClientId.secret).toBeFalsy();
    expect(LOGIN_FIELDS.restrictConditions.type).toBe('conditions');
    expect(LOGIN_FIELDS.restrictEnabled.type).toBe('boolean');
    expect(LOGIN_FIELDS.oauth2FieldMapSubject.env).toBeUndefined();
    expect(LOGIN_FIELDS.restrictEnabled.env).toBeUndefined();
  });
});

describe('applyOverlay 合并 auth', () => {
  it('DB 的 provider 覆盖 env AUTH_PROVIDER', () => {
    const merged = applyOverlay(loadBase(), storedConfig({ provider: 'cas' }));
    expect(merged.auth.provider).toBe('cas');
  });

  it('DB 无登录字段时保持空值（配置只存数据库）', () => {
    const merged = applyOverlay(loadConfig({ ...BASE_ENV }), storedConfig());
    expect(merged.auth.provider).toBe('oauth2');
    expect(merged.auth.oauth2.authorizationEndpoint).toBe('');
    expect(merged.auth.cas.loginUrl).toBe('');
  });

  it('oauth2 与 cas 字段各自独立，互不覆盖', () => {
    const merged = applyOverlay(
      loadBase(),
      storedConfig({
        oauth2AuthorizationEndpoint: 'https://oauth2.example.com/authorize',
        casLoginUrl: 'https://cas.example.com/login',
      })
    );
    expect(merged.auth.oauth2.authorizationEndpoint).toBe('https://oauth2.example.com/authorize');
    expect(merged.auth.cas.loginUrl).toBe('https://cas.example.com/login');
  });

  it('字段映射与登录限制可从 DB 覆盖', () => {
    const conditions = [
      { field: 'schoolCode' as const, path: '', value: '100051' },
      { field: 'custom' as const, path: 'data.user_id', value: '17908' },
    ];
    const merged = applyOverlay(
      loadBase(),
      storedConfig({
        oauth2FieldMapSubject: '{school_id}:{user_id}',
        oauth2FieldMapSchoolCode: 'data.school.id',
        restrictEnabled: true,
        restrictConditions: conditions,
      })
    );
    expect(merged.auth.oauth2.fieldMap.subject).toBe('{school_id}:{user_id}');
    expect(merged.auth.oauth2.fieldMap.schoolCode).toBe('data.school.id');
    expect(merged.auth.restrict.enabled).toBe(true);
    expect(merged.auth.restrict.conditions).toEqual(conditions);
  });

  it('overlay 合并返回新的 auth 对象，不修改 env base（深拷贝）', () => {
    const base = loadBase();
    const merged = applyOverlay(base, storedConfig({
      oauth2ClientId: 'db-client',
      oauth2FieldMapSubject: 'user_id',
      restrictConditions: [{ field: 'schoolCode', path: '', value: '100051' }],
    }));
    expect(merged.auth).not.toBe(base.auth);
    expect(merged.auth.oauth2).not.toBe(base.auth.oauth2);
    expect(merged.auth.oauth2.fieldMap).not.toBe(base.auth.oauth2.fieldMap);
    expect(merged.auth.cas).not.toBe(base.auth.cas);
    expect(merged.auth.restrict).not.toBe(base.auth.restrict);
    expect(merged.auth.restrict.conditions).not.toBe(base.auth.restrict.conditions);
    expect(base.auth.oauth2.clientId).not.toBe('db-client');
    expect(base.auth.oauth2.fieldMap.subject).toBe('');
    expect(base.auth.restrict.conditions).toEqual([]);
  });

  it('DB 来源的 URL 字段去尾斜杠，与 env 对齐', () => {
    const merged = applyOverlay(
      loadBase(),
      storedConfig({
        oauth2AuthorizationEndpoint: 'https://oauth2.example.com/authorize/',
        casLoginUrl: 'https://cas.example.com/login/',
      })
    );
    expect(merged.auth.oauth2.authorizationEndpoint).toBe('https://oauth2.example.com/authorize');
    expect(merged.auth.cas.loginUrl).toBe('https://cas.example.com/login');
  });

  it('每个登录字段都有可读写入口：applyLoginField 写入后 readLoginField 能读回', () => {
    const samples: Partial<Record<LoginField, ConfigValue>> = {
      provider: 'cas',
      oauth2AuthorizationEndpoint: 'https://oauth2.example.com/authorize',
      oauth2TokenEndpoint: 'https://oauth2.example.com/token',
      oauth2UserInfoEndpoint: 'https://oauth2.example.com/userinfo',
      oauth2ClientId: 'oauth2-client',
      oauth2ClientSecret: 'oauth2-secret',
      oauth2Scopes: 'openid profile',
      oauth2TokenAuthMethod: 'client_secret_post',
      oauth2UserInfoTokenCarrier: 'query',
      oauth2FieldMapSubject: '{school_id}:{user_id}',
      oauth2FieldMapEmail: 'email',
      oauth2FieldMapName: 'user_name',
      oauth2FieldMapSchoolCode: 'school_id',
      oauth2FieldMapSchoolName: 'school_name',
      oauth2FieldMapRoles: 'role_name',
      adminRoles: ['school_admin', 'super_admin'],
      casLoginUrl: 'https://cas.example.com/login',
      casTicketValidateUrl: 'https://cas.example.com/serviceValidate',
      wecomCorpId: 'wwCorp',
      wecomAgentId: '1000002',
      wecomClientSecret: 'wecom-secret',
      wecomScope: 'snsapi_privateinfo',
      restrictEnabled: true,
      restrictConditions: [{ field: 'schoolCode', path: '', value: '100051' }],
    };
    // 部署管理员三个字段不落在 auth 子树（它们在 portal.localAdmin），
    // 由 overlay.test.ts 单独覆盖，这里只校验真正走 auth 的字段
    const LOCAL_ADMIN_FIELDS: LoginField[] = [
      'localAdminMode',
      'localAdminUsername',
      'localAdminPassword',
    ];
    const authFields = LOGIN_FIELD_NAMES.filter((field) => !LOCAL_ADMIN_FIELDS.includes(field));
    expect([...authFields].sort()).toEqual(Object.keys(samples).sort());

    const auth = cloneAuth(loadBase().auth);
    for (const field of authFields) {
      const value = samples[field];
      if (value === undefined) continue;
      applyLoginField(auth, field, value);
      expect(readLoginField(auth, field), field).toEqual(value);
    }
  });
});

describe('getAuthAdapter', () => {
  it('provider 为 wecom 时取到企业微信适配器', () => {
    setOverlayStoredForTests(
      storedConfig({
        provider: 'wecom',
        wecomCorpId: 'wwCorp',
        wecomAgentId: '1000002',
        wecomClientSecret: 'wecom-secret',
      })
    );

    expect(getAuthAdapter().kind).toBe('wecom');
  });
});
