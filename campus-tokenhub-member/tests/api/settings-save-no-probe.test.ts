import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUT } from '@/app/api/portal/settings/route';
import { resetConfigCache } from '@/lib/config';
import { resetOverlayForTests } from '@/lib/config/overlay';
import {
  resetConfigStoreCache,
  setConfigRepoOverride,
} from '@/lib/config/store';
import { resetProbeDeps, setProbeClientFactory } from '@/lib/config/probe';
import { TencentApiError } from '@/lib/tencent/organization';
import { resetOrganizationClientCache } from '@/lib/tencent/factory';
import { signSession } from '@/lib/auth/session';
import { membersBaseEnv, stubAdminRoster } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const ADMIN_EMAIL = 'admin@school.edu.cn';
/** 管理员身份：写进名单桩（ADMIN_EMAILS 已移除，判定只认共享名单） */
const ADMIN_SUB = '7:17915';
const original = { ...process.env };

async function request(body: unknown): Promise<Request> {
  const token = await signSession({
    sub: ADMIN_SUB,
    email: ADMIN_EMAIL,
    name: '管理员',
  });
  return new Request('http://portal.test/api/portal/settings', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin: 'http://portal.test',
      host: 'portal.test',
      cookie: `portal_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env = {
    ...original,
    ...membersBaseEnv,
    MEMBER_ACCOUNT_PROVIDER: 'tencent',
    TENCENTCLOUD_SECRET_ID: '',
    TENCENTCLOUD_SECRET_KEY: '',
  };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
  stubAdminRoster([ADMIN_SUB]);
  resetProbeDeps();
  resetOrganizationClientCache();
  delete process.env.NEXT_RUNTIME;
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
  resetProbeDeps();
});

/**
 * 保存只负责落库：外部系统（腾讯云 CAM / 网关计费）由用户点「验证」按钮显式触发。
 * 否则每次保存都会打一次上游接口，还可能把没改过的分组徽标刷成不相关的结论。
 */
describe('保存不再自动探测', () => {
  it('保存腾讯云凭据不触发探测：上游即使报错也不影响保存', async () => {
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    let clientBuilds = 0;
    setProbeClientFactory(() => {
      clientBuilds += 1;
      throw new TencentApiError('AuthFailure.SignatureFailure', 'bad signature');
    });

    const response = await PUT(
      await request({ values: { tencentSecretId: 'AKIDx', tencentSecretKey: 'secret' } })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(clientBuilds).toBe(0);
    expect(state.calls.verify).toBe(0);
    expect(state.verify.tencent.status).toBe('unverified');
  });

});
