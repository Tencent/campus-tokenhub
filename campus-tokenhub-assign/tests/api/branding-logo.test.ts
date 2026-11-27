import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as readLogo } from '@/app/api/portal/branding/logo/route';
import { POST as uploadLogo } from '@/app/api/portal/settings/logo/route';
import { resetConfigCache } from '@/lib/config';
import { clearAdminRoster, stubAdminRoster } from '../helpers/admin-roster';
import { resetOverlayForTests } from '@/lib/config/overlay';
import {
  resetConfigStoreCache,
  setConfigRepoOverride,
} from '@/lib/config/store';
import { signSession } from '@/lib/auth/session';
import { membersBaseEnv } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const ADMIN_EMAIL = 'admin@school.edu.cn';
const original = { ...process.env };

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

async function requestWith(
  method: string,
  path: string,
  body: BodyInit | null,
  options: { type?: string; email?: string | null; origin?: string } = {}
): Promise<Request> {
  const headers: Record<string, string> = {
    origin: options.origin ?? 'http://portal.test',
    host: 'portal.test',
  };
  if (options.type) headers['content-type'] = options.type;
  if (options.email !== null) {
    const token = await signSession({
      sub: '7:17915',
      email: options.email ?? ADMIN_EMAIL,
      name: '管理员',
      octafuseUserId: 'gw-1',
    });
    headers.cookie = `portal_session=${token}`;
  }
  return new Request(`http://portal.test${path}`, { method, headers, body });
}

beforeEach(() => {
  stubAdminRoster(['7:17915']);
  process.env = { ...original, ...membersBaseEnv };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
  const { repo } = memoryConfigRepo();
  setConfigRepoOverride(repo);
});

afterEach(() => {
  clearAdminRoster();
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
});

describe('POST /api/portal/settings/logo', () => {
  it('非管理员返回 403', async () => {
    // 名单里没有这个身份，且未认领 owner → 非管理员
    stubAdminRoster([]);
    const response = await uploadLogo(
      await requestWith('POST', '/api/portal/settings/logo', PNG_BYTES, {
        type: 'image/png',
        email: 'teacher@school.edu.cn',
      })
    );
    expect(response.status).toBe(403);
  });

  it('类型不支持返回 400 与 invalid_logo_type', async () => {
    const response = await uploadLogo(
      await requestWith('POST', '/api/portal/settings/logo', 'hello', { type: 'text/plain' })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_logo_type');
  });

  it('超过 200KB 返回 400 与 logo_too_large', async () => {
    const big = new Uint8Array(200 * 1024 + 1);
    const response = await uploadLogo(
      await requestWith('POST', '/api/portal/settings/logo', big, { type: 'image/png' })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('logo_too_large');
  });

  it('合法 PNG 保存成功，读取得到相同字节与 content-type', async () => {
    const upload = await uploadLogo(
      await requestWith('POST', '/api/portal/settings/logo', PNG_BYTES, { type: 'image/png' })
    );
    expect(upload.status).toBe(200);

    const read = await readLogo();
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    expect(read.headers.get('cache-control')).toContain('max-age=300');

    const bytes = new Uint8Array(await read.arrayBuffer());
    expect([...bytes]).toEqual([...PNG_BYTES]);
  });

  it('跨源返回 403', async () => {
    const response = await uploadLogo(
      await requestWith('POST', '/api/portal/settings/logo', PNG_BYTES, {
        type: 'image/png',
        origin: 'http://evil.test',
      })
    );
    expect(response.status).toBe(403);
  });
});

describe('GET /api/portal/branding/logo', () => {
  it('未配置时返回 404 与 logo_absent', async () => {
    const response = await readLogo();
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('logo_absent');
  });
});
