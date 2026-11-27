import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, PUT } from '@/app/api/portal/settings/route';
import { resetConfigCache } from '@/lib/config';
import { clearAdminRoster, stubAdminRoster } from '../helpers/admin-roster';
import { getOverlaySnapshot, resetOverlayForTests } from '@/lib/config/overlay';
import {
  resetConfigStoreCache,
  setConfigRepoOverride,
} from '@/lib/config/store';
import { resetRuntimeSecretProvider } from '@/lib/config/secrets';
import { memberRequest, membersBaseEnv } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const ENDPOINT = 'http://portal.test/api/portal/settings';
const ADMIN_EMAIL = 'admin@school.edu.cn';

const original = { ...process.env };

/** 标准 OAuth2 的 clientSecret 明文 */
const SECRETS = {
  'oauth2ClientSecret': 'oauth2-client-secret-1111',
} as const;

/**
 * 设置页是整表提交：SSO 五项必须一起保存，否则会被「登录配置不完整」拦下。
 * 这里给出四项非密钥字段，配合 SECRETS 组成一次完整提交。
 */
const OAUTH2_BASE = {
  'oauth2AuthorizationEndpoint': 'https://idp.example.com/oauth2/authorize',
  'oauth2TokenEndpoint': 'https://idp.example.com/oauth2/token',
  'oauth2UserInfoEndpoint': 'https://idp.example.com/oauth2/userinfo',
  'oauth2ClientId': 'client-id',
};

const FULL_OAUTH2 = { ...OAUTH2_BASE, ...SECRETS };

function resetEnv(extra: Record<string, string | undefined> = {}): void {
  process.env = {
    ...original,
    ...membersBaseEnv,
    NODE_ENV: 'test',
    ...extra,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
  }
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
}

async function request(method: 'GET' | 'PUT', body?: unknown): Promise<Request> {
  return memberRequest(ENDPOINT, { method, email: ADMIN_EMAIL, body });
}

function encLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Buffer.isBuffer(value) ? value.length : String(value).length;
}

beforeEach(() => {
  stubAdminRoster(['7:17915']);
  resetEnv();
});

afterEach(() => {
  clearAdminRoster();
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

    const response = await PUT(await request('PUT', { values: { ...FULL_OAUTH2 } }));
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

    await PUT(await request('PUT', { values: { ...FULL_OAUTH2 } }));

expect(getOverlaySnapshot().stored?.login.oauth2ClientSecret).toBe(SECRETS.oauth2ClientSecret);
  });
});

describe('GET /api/portal/settings 对 auth 密钥脱敏', () => {
  it('只回显尾号与长度，响应体不含明文', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    await PUT(await request('PUT', { values: { ...FULL_OAUTH2 } }));

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

  it('极短密钥不回显完整明文', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    await PUT(await request('PUT', { values: { ...FULL_OAUTH2, 'oauth2ClientSecret': 'abcd' } }));

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

    await PUT(await request('PUT', { values: { ...FULL_OAUTH2 } }));

    for (const audit of state.audits) {
      expect(JSON.stringify(audit)).not.toContain('client-secret-');
    }
    const secretAudits = state.audits.filter(
      (entry) => entry.key === 'auth.oauth2.clientSecret'
    );
    expect(secretAudits).toHaveLength(1);
    expect(secretAudits[0].valueHint).toBe('…1111');
  });
});
