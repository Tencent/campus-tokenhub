import { beforeEach, describe, expect, it } from 'vitest';
import {
  groupStatus,
  readStoredConfig,
  resetConfigStoreCache,
  setVerifyState,
} from '@/lib/config/store';
import { memoryConfigRepo } from '../../helpers/config';

beforeEach(() => {
  resetConfigStoreCache();
});

describe('验证状态', () => {
  it('分组状态直接取该组的整体状态', async () => {
    const { repo } = memoryConfigRepo();
    await setVerifyState('currency', 'ok', null, repo);
    expect(groupStatus(await readStoredConfig(repo), 'currency')).toBe('ok');

    await setVerifyState('currency', 'unverified', null, repo);
    expect(groupStatus(await readStoredConfig(repo), 'currency')).toBe('unverified');
  });

});
