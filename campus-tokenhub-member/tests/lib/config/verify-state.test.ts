import { beforeEach, describe, expect, it } from 'vitest';
import {
  groupStatus,
  readStoredConfig,
  resetConfigStoreCache,
  setVerifyState,
  type ConfigRepo,
} from '@/lib/config/store';
import { memoryConfigRepo } from '../../helpers/config';

beforeEach(() => {
  resetConfigStoreCache();
});

describe('验证状态', () => {
  it('按分组写入后可读回，消息超过 200 字符被截断', async () => {
    const { repo } = memoryConfigRepo();
    await setVerifyState('tencent', 'failed', 'x'.repeat(500), repo);

    const stored = await readStoredConfig(repo);
    expect(stored.verify.tencent.status).toBe('failed');
    expect((stored.verify.tencent.message ?? '').length).toBe(200);
    expect(stored.verify.tencent.verifiedAt).toMatch(/^\d{4}-/);
  });

  it('分组状态直接取该组的整体状态', async () => {
    const { repo } = memoryConfigRepo();
    await setVerifyState('currency', 'ok', null, repo);
    expect(groupStatus(await readStoredConfig(repo), 'currency')).toBe('ok');

    await setVerifyState('currency', 'unverified', null, repo);
    expect(groupStatus(await readStoredConfig(repo), 'currency')).toBe('unverified');
  });

  it('分组内字段解密失败时状态按 failed 处理', () => {
    const { repo } = memoryConfigRepo({ tencentSecretKey: Buffer.from('bad') });
    return readStoredConfig(repo).then((result) => {
      expect(result.brokenFields).toEqual(['tencentSecretKey']);
      expect(groupStatus(result, 'tencent')).toBe('failed');
    });
  });

  it('验证状态写入失败只告警，不影响配置读取', async () => {
    const failing: ConfigRepo = {
      ...memoryConfigRepo().repo,
      async setVerify(): Promise<void> { throw new Error('verify down'); },
    };
    await expect(setVerifyState('tencent', 'ok', null, failing)).resolves.toBeUndefined();
    expect((await readStoredConfig(failing)).verify.tencent.status).toBe('unverified');
  });
});
