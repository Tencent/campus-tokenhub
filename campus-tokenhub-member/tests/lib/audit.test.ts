import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { audit, buildAuditRecord, clientIp, maskSecrets } from '@/lib/audit';
import { resetRuntimeSecretProvider, setRuntimeSecretProvider } from '@/lib/config/secrets';
import {
  ensureConfigOverlayLoaded,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';
import { storedConfig } from '../helpers/config';

const PASSWORD = 'admin-pw-should-never-appear';
const SESSION_SECRET = 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d';

const baseEnv = {
  PORTAL_ADMIN_USERNAME: 'admin',
  PORTAL_ADMIN_PASSWORD: PASSWORD,
  SESSION_SECRET,
};

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  resetRuntimeSecretProvider();
});

describe('buildAuditRecord', () => {
  it('字段齐全且缺省填 null', () => {
    const record = buildAuditRecord('key.create', { actor_email: 'a@school.edu' });

    expect(Object.keys(record)).toEqual([
      'ts',
      'event',
      'actor_email',
      'actor_external_id',
      'octafuse_user_id',
      'target',
      'result',
      'detail',
      'ip',
      'ua',
    ]);
    expect(record.actor_email).toBe('a@school.edu');
    expect(record.actor_external_id).toBeNull();
    expect(record.target).toBeNull();
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sk- 开头的值被脱敏', () => {
    const record = buildAuditRecord('key.create', { target: 'sk-abcdef1234567890' });

    expect(record.target).toBe('sk-***');
  });

  it('管理员密码与会话密钥不会出现在任何字段里', () => {
    const record = buildAuditRecord('auth.login', {
      ua: `pw=${PASSWORD} secret=${SESSION_SECRET}`,
      ip: '10.0.0.1',
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain(SESSION_SECRET);
    expect(record.ip).toBe('10.0.0.1');
  });

  it('超长字段被截断，避免日志被撑爆', () => {
    const record = buildAuditRecord('auth.login', { ua: 'x'.repeat(2000) });
    expect((record.ua ?? '').length).toBeLessThanOrEqual(512);
  });

  it('M1：先脱敏再截断——密钥出现在 512 字符之后也不会泄漏', () => {
    const record = buildAuditRecord('auth.login', { ua: `${'x'.repeat(600)}${PASSWORD}` });
    expect(JSON.stringify(record)).not.toContain(PASSWORD);
  });

  it('M1：OAUTH2_CLIENT_SECRET 同样不出现在日志里', () => {
    Object.assign(process.env, { OAUTH2_CLIENT_SECRET: 'oauth2-client-secret-value' });
    resetConfigCache();

    const record = buildAuditRecord('auth.login', { ua: 'ua=oauth2-client-secret-value' });
    expect(JSON.stringify(record)).not.toContain('oauth2-client-secret-value');

    delete process.env.OAUTH2_CLIENT_SECRET;
    resetConfigCache();
  });

  it('M1：企微 Secret 不出现在 auth.login / auth.login.fail 审计 detail', async () => {
    const WECOM_SECRET = 'wecom-client-secret-should-never-appear';
    resetOverlayForTests();
    setOverlayLoader(async () =>
      storedConfig({ wecomClientSecret: WECOM_SECRET } as Parameters<typeof storedConfig>[0])
    );
    await ensureConfigOverlayLoaded(1000);

    for (const event of ['auth.login', 'auth.login.fail'] as const) {
      const record = buildAuditRecord(event, { detail: `err=login secret=${WECOM_SECRET}` });
      expect(JSON.stringify(record)).not.toContain(WECOM_SECRET);
    }

    resetOverlayForTests();
  });
});

describe('audi() 输出', () => {
  it('每次一行合法 JSON', () => {
    const lines: string[] = [];
    audit('auth.login', { actor_email: 'a@school.edu', result: 'success' }, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ event: 'auth.login', result: 'success' });
  });

  it('sink 抛错不影响业务流程', () => {
    expect(() =>
      audit('auth.login', {}, () => {
        throw new Error('stdout closed');
      })
    ).not.toThrow();
  });
});

describe('maskSecrets', () => {
  it('一处出现多次也全部替换', () => {
    expect(maskSecrets('sk-aaaaaaaaaa and sk-bbbbbbbbbb')).toBe('sk-*** and sk-***');
  });

  it('普通文本原样返回', () => {
    expect(maskSecrets('normal message')).toBe('normal message');
  });

  it('运行期密钥（配置表里的腾讯云 AK/SK）同样被抹掉', () => {
    setRuntimeSecretProvider(() => ['AKIDruntimeSecret1234']);
    expect(maskSecrets('id=AKIDruntimeSecret1234 done')).toBe('id=*** done');
  });

  it('运行期密钥来源抛错时不影响 env 密钥脱敏，也不抛错', () => {
    setRuntimeSecretProvider(() => {
      throw new Error('overlay not ready');
    });
    expect(maskSecrets(`pw=${PASSWORD}`)).toBe('pw=***');
  });
});

describe('clientIp', () => {
  it('优先取 x-forwarded-for 的第一段', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
    expect(clientIp(headers)).toBe('1.2.3.4');
  });

  it('回退到 x-real-ip，再取不到返回 null', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '5.6.7.8' }))).toBe('5.6.7.8');
    expect(clientIp(new Headers())).toBeNull();
  });
});
