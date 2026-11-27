import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, PUT } from '@/app/api/portal/settings/route';
import { resetConfigCache } from '@/lib/config';
import { getOverlaySnapshot, resetOverlayForTests } from '@/lib/config/overlay';
import {
  resetConfigStoreCache,
  setConfigRepoOverride,
} from '@/lib/config/store';
import { resetRuntimeSecretProvider } from '@/lib/config/secrets';
import { memberRequest, membersBaseEnv, stubAdminRoster } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const ENDPOINT = 'http://portal.test/api/portal/settings';
const ADMIN_EMAIL = 'admin@school.edu.cn';
/** 管理员身份：写进名单桩，管理员判定只认共享名单 */
const ADMIN_SUB = '7:17915';

const original = { ...process.env };

/** 标准 OAuth2 的 clientSecret 明文 */
const SECRETS = {
  'oauth2ClientSecret': 'oauth2-client-secret-1111',
} as const;

const OAUTH2_ENV = {
  AUTH_PROVIDER: 'oauth2',
  OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/oauth2/authorize',
  OAUTH2_TOKEN_ENDPOINT: 'https://idp.example.com/oauth2/token',
  OAUTH2_USERINFO_ENDPOINT: 'https://idp.example.com/oauth2/userinfo',
  OAUTH2_CLIENT_ID: 'env-client-id',
  OAUTH2_CLIENT_SECRET: 'env-oauth2-secret-4444',
};

function resetEnv(extra: Record<string, string | undefined> = {}): void {
  process.env = {
    ...original,
    ...membersBaseEnv,
    ...OAUTH2_ENV,
    NODE_ENV: 'test',
    ...extra,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
  }
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
  stubAdminRoster([ADMIN_SUB]);
}

async function request(method: 'GET' | 'PUT', body?: unknown): Promise<Request> {
  return memberRequest(ENDPOINT, { method, sub: ADMIN_SUB, email: ADMIN_EMAIL, body });
}

function encLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Buffer.isBuffer(value) ? value.length : String(value).length;
}

beforeEach(() => {
  resetEnv();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
  resetRuntimeSecretProvider();
  resetConfigStoreCache();
});

describe('auth clientSecret 加密存储', () => {
  it('保存 OAuth2 的 clientSecret 后 value_plain 为空、value_enc 非空', async () => {
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(await request('PUT', { values: { ...SECRETS } }));
    expect(response.status).toBe(200);

    for (const [key, plain] of Object.entries(SECRETS)) {
      const raw = state.values[key as keyof typeof state.values];
      expect(raw, `${key} 应落库`).toBeTruthy();
      expect(Buffer.isBuffer(raw)).toBe(true);
      expect(encLength(raw)).toBeGreaterThan(0);
      expect(String(raw)).not.toContain(plain);
    }
  });

  it('落库的密文能被 overlay 解回并成为生效配置', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    await PUT(await request('PUT', { values: { ...SECRETS } }));

expect(getOverlaySnapshot().stored?.login.oauth2ClientSecret).toBe(SECRETS.oauth2ClientSecret);
  });
});

describe('GET /api/portal/settings 对 auth 密钥脱敏', () => {
  it('只回显尾号与长度，响应体不含明文', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    await PUT(await request('PUT', { values: { ...SECRETS } }));

    const response = await GET(await request('GET'));
    const raw = await response.text();
    for (const plain of Object.values(SECRETS)) {
      expect(raw).not.toContain(plain);
    }

    const body = JSON.parse(raw);
    for (const [key, plain] of Object.entries(SECRETS)) {
      expect(body.secrets[key]).toEqual({
        configured: true,
        hint: `…${plain.slice(-4)}`,
        length: plain.length,
      });
    }
  });

  it('非 env 模式：仅 env 配置的 clientSecret 也显示已配置', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await GET(await request('GET'));
    const raw = await response.text();
    expect(raw).not.toContain('env-oauth2-secret-4444');

    const body = JSON.parse(raw);
    expect(body.secrets['oauth2ClientSecret']).toEqual({
      configured: true,
      hint: '…4444',
      length: 'env-oauth2-secret-4444'.length,
    });
  });

  it('极短密钥不回显完整明文', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    await PUT(await request('PUT', { values: { 'oauth2ClientSecret': 'abcd' } }));

    const response = await GET(await request('GET'));
    const body = await response.json();
    expect(body.secrets['oauth2ClientSecret']).toEqual({
      configured: true,
      hint: '***',
      length: 4,
    });
  });
});

describe('审计不落密钥明文', () => {
  it('审计记录只保留尾号', async () => {
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    await PUT(await request('PUT', { values: { ...SECRETS } }));

    expect(state.audits).toHaveLength(1);
    for (const audit of state.audits) {
      expect(JSON.stringify(audit)).not.toContain('client-secret-');
    }
    const hints = state.audits
      .map((entry) => [entry.key, entry.valueHint] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    expect(hints).toEqual([['auth.oauth2.clientSecret', '…1111']]);
  });
});
