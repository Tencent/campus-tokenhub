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

function resetEnv(extra: Record<string, string | undefined> = {}): void {
  process.env = { ...original, ...membersBaseEnv, ...extra };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
  }
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
}

async function request(
  method: 'GET' | 'PUT',
  options: { body?: unknown; email?: string | null; origin?: string } = {}
): Promise<Request> {
  if (options.email === null) {
    return new Request(ENDPOINT, {
      method,
      headers: { origin: options.origin ?? 'http://portal.test', 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }
  return memberRequest(ENDPOINT, {
    method,
    email: options.email ?? ADMIN_EMAIL,
    origin: options.origin,
    body: options.body,
  });
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

describe('GET /api/portal/settings', () => {
  it('未登录返回 401', async () => {
    const response = await GET(await request('GET', { email: null }));
    expect(response.status).toBe(401);
  });

  it('非管理员返回 403 与 not_settings_admin', async () => {
    stubAdminRoster([]);
    const response = await GET(await request('GET', { email: 'teacher@school.edu.cn' }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.code).toBe('not_settings_admin');
  });

  it('敏感键只返回配置状态与尾号，响应体不含明文', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    await PUT(
      await request('PUT', {
        body: { values: {
            provider: 'oauth2',
            oauth2AuthorizationEndpoint: 'https://idp.test/authorize',
            oauth2TokenEndpoint: 'https://idp.test/token',
            oauth2UserInfoEndpoint: 'https://idp.test/userinfo',
            oauth2ClientId: 'client-1',
            oauth2ClientSecret: 'AKIDexample1234567890',
          } },
      })
    );

    const response = await GET(await request('GET'));
    const raw = await response.text();
    expect(raw).not.toContain('AKIDexample1234567890');

    const body = JSON.parse(raw);
    expect(body.secrets['oauth2ClientSecret']).toEqual({
      configured: true,
      hint: '…7890',
      length: 'AKIDexample1234567890'.length,
    });
  });

  it('CONFIG_SOURCE 不再影响读写：设成 env 也返回数据库视图', async () => {
    resetEnv({ CONFIG_SOURCE: 'env' });
    const { repo } = memoryConfigRepo({ schoolName: '某某大学' });
    setConfigRepoOverride(repo);

    const response = await GET(await request('GET'));
    const body = await response.json();
    expect(body.readOnly).toBeUndefined();
    expect(body.values['schoolName']).toBe('某某大学');
  });
});

describe('PUT /api/portal/settings', () => {
  it('只读的部署参数不是可配置字段，返回 unknown_key', async () => {
    const response = await PUT(
      await request('PUT', { body: { values: { PORTAL_BASE_PATH: '/tokenhub/portal' } } })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('unknown_key');
  });

  it('未注册键返回 400 与 unknown_key', async () => {
    const response = await PUT(
      await request('PUT', { body: { values: { 'portal.unknown': 'x' } } })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('unknown_key');
  });

  it('任一字段非法时整份不写入', async () => {
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await request('PUT', {
        body: { values: { 'schoolName': '某某大学', 'defaultBudgetMax': -1 } },
      })
    );

    expect(response.status).toBe(400);
    expect(Object.values(state.values).filter((value) => value !== null).length).toBe(0);
  });

  it('保存成功后运行期配置立即生效', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    resetOverlayForTests();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await request('PUT', { body: { values: { 'schoolName': '某某大学' } } })
    );
    expect(response.status).toBe(200);

    expect(getOverlaySnapshot().stored?.app.schoolName).toBe('某某大学');
  });

  it('跨源返回 403', async () => {
    const response = await PUT(
      await request('PUT', {
        body: { values: { 'schoolName': '某某大学' } },
        origin: 'http://evil.test',
      })
    );
    expect(response.status).toBe(403);
  });

  it('写入记录审计：敏感值只留尾号', async () => {
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    await PUT(
      await request('PUT', { body: { values: {
            provider: 'oauth2',
            oauth2AuthorizationEndpoint: 'https://idp.test/authorize',
            oauth2TokenEndpoint: 'https://idp.test/token',
            oauth2UserInfoEndpoint: 'https://idp.test/userinfo',
            oauth2ClientId: 'client-1',
            oauth2ClientSecret: 'AKIDexample1234567890',
          } } })
    );

    // 一次保存多个字段会有多条审计；密钥那条只留尾号
    const secretAudit = state.audits.find((item) => item.valueHint === '…7890');
    expect(secretAudit).toBeTruthy();
    expect(JSON.stringify(state.audits)).not.toContain('AKIDexample1234567890');
  });

  it('生产环境保存不受支持的 SSO 协议返回 400 且不落库', async () => {
    resetEnv({
      NODE_ENV: 'production',
      MEMBER_ACCOUNT_PROVIDER: 'tencent',
      AUTH_PROVIDER: 'oauth2',
      OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/oauth2/authorize',
      OAUTH2_TOKEN_ENDPOINT: 'https://idp.example.com/oauth2/token',
      OAUTH2_USERINFO_ENDPOINT: 'https://idp.example.com/oauth2/userinfo',
      OAUTH2_CLIENT_ID: 'cid',
      OAUTH2_CLIENT_SECRET: 'secret',
    });
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await request('PUT', { body: { values: { 'provider': 'oidc' } } })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('auth_unsafe');
    expect(Object.values(state.values).filter((value) => value !== null).length).toBe(0);
  });
});
