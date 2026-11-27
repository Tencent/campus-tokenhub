import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache, type AppConfig } from '@/lib/config';
import {
  ConfigValueError,
  FIELDS,
  SECRET_FIELD_NAMES,
  toConfigValue,
  validateField,
  type ConfigField,
  type ConfigValue,
  type LoginField,
} from '@/lib/config/fields';
import {
  applyLoginField,
  applyOverlay,
  cloneAuth,
  readLoginField,
  resetOverlayForTests,
  setOverlayStoredForTests,
} from '@/lib/config/overlay';
import {
  isSsoConfigured,
  mergeDraftAuth,
  requiredSsoFields,
  validateAuthSectionErrors,
} from '@/lib/config/auth-validate';
import { encryptConfigValue } from '@/lib/config/crypto';
import { resetConfigStoreCache, setConfigRepoOverride } from '@/lib/config/store';
import { memoryConfigRepo, storedConfig } from '../../helpers/config';

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'T3st-Admin-Pass-9f2c',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'wecom-config-test-session-secret-32chars!',
  CONFIG_ENCRYPTION_KEY: 'wecom-config-test-encryption-key-32chars!',
};

const original = { ...process.env };

const CORP_ID = 'ww1234567890abcdef';
const AGENT_ID = '1000002';
const SECRET = 'wecom-client-secret-123456';

// 新字段在 TDD 红阶段尚未注册：用断言对象做运行时校验，类型上的 as 只是为了让用例可编译
const FIELD = {
  corp: 'wecomCorpId' as LoginField,
  agent: 'wecomAgentId' as LoginField,
  secret: 'wecomClientSecret' as LoginField,
  scope: 'wecomScope' as LoginField,
};

type WecomAuth = { corpId: string; agentId: string; secret: string; scope: string };

function wecomOf(auth: AppConfig['auth']): WecomAuth {
  return (auth as AppConfig['auth'] & { wecom: WecomAuth }).wecom;
}

function wecomStored(values: Partial<Record<ConfigField, ConfigValue>> = {}) {
  return storedConfig({
    provider: 'wecom',
    [FIELD.corp]: CORP_ID,
    [FIELD.agent]: AGENT_ID,
    [FIELD.secret]: SECRET,
    ...values,
  });
}

function readyAuth(): AppConfig['auth'] {
  return applyOverlay(loadConfig(BASE_ENV), wecomStored()).auth;
}

beforeEach(() => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigStoreCache();
  resetConfigCache();
  resetOverlayForTests();
});

describe('wecom 配置字段描述符', () => {
  it('四个字段按 D6 声明列名、类型、密钥标记与枚举', () => {
    expect(FIELDS[FIELD.corp]).toMatchObject({
      column: 'wecom_corp_id', section: 'login', auditName: 'auth.wecom.corpId', type: 'string',
    });
    expect(FIELDS[FIELD.agent]).toMatchObject({
      column: 'wecom_agent_id', section: 'login', auditName: 'auth.wecom.agentId',
      type: 'string', pattern: /^\d+$/,
    });
    expect(FIELDS[FIELD.secret]).toMatchObject({
      column: 'wecom_client_secret_enc', section: 'login', auditName: 'auth.wecom.clientSecret',
      cryptoKey: 'auth.wecom.clientSecret', type: 'string', secret: true,
    });
    expect(FIELDS[FIELD.scope]).toMatchObject({
      column: 'wecom_scope', section: 'login', auditName: 'auth.wecom.scope',
      type: 'enum', enumValues: ['snsapi_base', 'snsapi_privateinfo'],
    });
    expect(SECRET_FIELD_NAMES).toContain(FIELD.secret);
  });

  it('AgentID 只接受纯数字，scope 只接受枚举值，并给出字段级错误', () => {
    expect(toConfigValue(FIELD.agent, AGENT_ID)).toBe(AGENT_ID);
    expect(() => toConfigValue(FIELD.agent, 'ww123')).toThrow(ConfigValueError);
    const invalid = validateField(FIELD.agent, 'ww-123');
    expect(invalid).toMatchObject({ field: FIELD.agent });
    expect(invalid?.message).toMatch(/数字|AgentId|应用详情/);

    expect(toConfigValue(FIELD.scope, 'snsapi_privateinfo')).toBe('snsapi_privateinfo');
    expect(() => toConfigValue(FIELD.scope, 'snsapi_userinfo')).toThrow(ConfigValueError);
  });
});

describe('wecom overlay 读写', () => {
  it('stored 值覆盖 base；wecomScope 未配置时回落 snsapi_base', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(base, wecomStored());

    expect(merged.auth.provider).toBe('wecom');
    expect(wecomOf(merged.auth)).toMatchObject({
      corpId: CORP_ID, agentId: AGENT_ID, secret: SECRET, scope: 'snsapi_base',
    });
    expect(wecomOf(base.auth).corpId).toBe('');

    const privateScope = applyOverlay(base, wecomStored({ [FIELD.scope]: 'snsapi_privateinfo' }));
    expect(wecomOf(privateScope.auth).scope).toBe('snsapi_privateinfo');
  });

  it('readLoginField / applyLoginField / cloneAuth 都覆盖 wecom', () => {
    const auth = readyAuth();
    expect(readLoginField(auth, FIELD.corp)).toBe(CORP_ID);
    expect(readLoginField(auth, FIELD.secret)).toBe(SECRET);
    expect(readLoginField(auth, FIELD.scope)).toBe('snsapi_base');

    const copy = cloneAuth(auth);
    expect(copy).not.toBe(auth);
    applyLoginField(copy, FIELD.corp, 'wwChanged');
    applyLoginField(copy, FIELD.agent, '2000001');
    applyLoginField(copy, FIELD.secret, 'new-secret');
    applyLoginField(copy, FIELD.scope, 'snsapi_privateinfo');

    expect(wecomOf(copy)).toMatchObject({
      corpId: 'wwChanged', agentId: '2000001', secret: 'new-secret', scope: 'snsapi_privateinfo',
    });
    expect(wecomOf(auth)).toMatchObject({ corpId: CORP_ID, agentId: AGENT_ID });
  });
});

describe('wecom 必填与已对接判定', () => {
  it('requiredSsoFields 只列 CorpID / AgentID / Secret，scope 不参与必填', () => {
    expect(requiredSsoFields(readyAuth()).map((item) => item.key)).toEqual([
      FIELD.corp, FIELD.agent, FIELD.secret,
    ]);
  });

  it('三项齐全才算已对接，缺一项或空白串都算未配置', () => {
    const auth = readyAuth();
    expect(isSsoConfigured(auth)).toBe(true);

    for (const [key, value] of [
      [FIELD.corp, ''],
      [FIELD.agent, '   '],
      [FIELD.secret, ''],
    ] as const) {
      const copy = cloneAuth(auth);
      applyLoginField(copy, key, value);
      expect(isSsoConfigured(copy)).toBe(false);
    }
  });

  it('validateAuthSectionErrors 返回必填与 AgentID 格式的字段级错误', () => {
    expect(validateAuthSectionErrors(readyAuth(), 'test')).toEqual([]);

    const invalid = cloneAuth(readyAuth());
    applyLoginField(invalid, FIELD.corp, '');
    applyLoginField(invalid, FIELD.agent, 'ww123');
    const keys = validateAuthSectionErrors(invalid, 'test').map((error) => error.key);
    expect(keys).toContain(FIELD.corp);
    expect(keys).toContain(FIELD.agent);
  });

  it('mergeDraftAuth 清空 wecomScope 回落到 snsapi_base', () => {
    const merged = mergeDraftAuth(readyAuth(), {}, [FIELD.scope]);
    expect(wecomOf(merged).scope).toBe('snsapi_base');
  });
});

describe('设置页 wecom 状态', () => {
  it('Secret 只回显是否已配置 + 尾号 + 长度，明文不进 effective', async () => {
    const encrypted = Buffer.from(
      encryptConfigValue(SECRET, 'auth.wecom.clientSecret'),
      'utf8'
    );
    const { repo } = memoryConfigRepo({
      provider: 'wecom',
      [FIELD.corp]: CORP_ID,
      [FIELD.agent]: AGENT_ID,
      [FIELD.secret]: encrypted,
      [FIELD.scope]: 'snsapi_base',
    });
    setConfigRepoOverride(repo);
    setOverlayStoredForTests(wecomStored({ [FIELD.scope]: null }));

    const { loadSettingsPayload } = await import('@/lib/config/settings-view');
    const payload = await loadSettingsPayload();

    expect(payload.secrets[FIELD.secret]).toEqual({
      configured: true, hint: `…${SECRET.slice(-4)}`, length: SECRET.length,
    });
    expect(payload.effective[FIELD.scope]).toBe('snsapi_base');
    expect(payload.effective[FIELD.corp]).toBe(CORP_ID);
    expect(payload.effective[FIELD.agent]).toBe(AGENT_ID);
    expect(payload.effective[FIELD.secret]).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });
});
