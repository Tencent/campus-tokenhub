import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { resetConfigCryptoCache } from '@/lib/config/crypto';
import { localAdminFingerprint, seedLocalAdminCredentialFromEnv } from '@/lib/auth/local-admin';
import { memoryConfigRepo } from '../helpers/config';

const BASE_ENV: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'fingerprint-test-session-secret-32ch',
  PORTAL_ADMIN_USERNAME: 'ops-admin',
  PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
};

const SEED_ENV = {
  PORTAL_ADMIN_USERNAME: 'ops-admin',
  PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
};

function cfg(extra: Record<string, string> = {}) {
  return loadConfig({ ...BASE_ENV, ...extra });
}

/**
 * 指纹用来判断「.env 里的那套凭据与库内生效的是不是同一套」。
 * 口径必须与登录校验完全一致：用户名归一同一个函数，口令不 trim。
 */
describe('localAdminFingerprint', () => {
  it('同一套凭据指纹相同', () => {
    expect(localAdminFingerprint(cfg())).toBe(localAdminFingerprint(cfg()));
  });

  it('用户名大小写与首尾空白归一（和登录校验同一口径）', () => {
    expect(localAdminFingerprint(cfg({ PORTAL_ADMIN_USERNAME: ' OPS-Admin ' }))).toBe(
      localAdminFingerprint(cfg())
    );
  });

  it('口令差一个字符即不同', () => {
    expect(
      localAdminFingerprint(cfg({ PORTAL_ADMIN_PASSWORD: 'bootstrap-password-12345' }))
    ).not.toBe(localAdminFingerprint(cfg()));
    // 口令按原样参与指纹：env 取值本身会被 config 去掉首尾空白，
    // 所以这里用「中间插一个字符」而不是前后空格来验证不折叠
    expect(
      localAdminFingerprint(cfg({ PORTAL_ADMIN_PASSWORD: 'bootstrap-passsword-1234' }))
    ).not.toBe(localAdminFingerprint(cfg()));
  });

  it('缺凭据时没有指纹', () => {
    expect(
      localAdminFingerprint(cfg({ PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' }))
    ).toBeNull();
  });

  it('指纹不含明文（长度固定 12，且看不出口令）', () => {
    const fingerprint = localAdminFingerprint(cfg())!;
    expect(fingerprint).toHaveLength(12);
    expect(fingerprint).not.toContain('ops-admin');
    expect(fingerprint).not.toContain('bootstrap');
  });
});

/** 加密要密钥材料：测试里临时给一个，不依赖真实部署的 .env */
async function withSessionSecret<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'seed-test-session-secret-32-characters';
  resetConfigCryptoCache();
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
    resetConfigCryptoCache();
  }
}

/**
 * 共享库是部署管理员凭据的唯一权威：
 * 库内为空时用 .env 种一次，之后改 .env 不再生效——两站因此读到同一份口令。
 */
describe('seedLocalAdminCredentialFromEnv', () => {
  it('env 没有凭据时不写库', async () => {
    const { repo, state } = memoryConfigRepo();
    await expect(
      seedLocalAdminCredentialFromEnv({
        env: { PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' },
        repo,
      })
    ).resolves.toBe('no_env');
    expect(state.calls.write).toBe(0);
    expect(state.values.localAdminUsername).toBeUndefined();
  });

  it('库内为空时把 env 凭据加密写入，并留一条 system 审计', async () => {
    await withSessionSecret(async () => {
      const { repo, state } = memoryConfigRepo();
      await expect(seedLocalAdminCredentialFromEnv({ env: SEED_ENV, repo })).resolves.toBe(
        'seeded'
      );

      expect(state.values.localAdminUsername).toBe('ops-admin');
      const enc = state.values.localAdminPassword as Buffer;
      expect(Buffer.isBuffer(enc)).toBe(true);
      // 落库必须是密文：既不是明文本身，也不含明文片段
      expect(enc.toString('utf8')).not.toContain('bootstrap-password-1234');

      expect(
        state.audits.some(
          (entry) =>
            entry.action === 'set' &&
            entry.key === 'auth.localAdmin.password' &&
            entry.actorSub === 'system:local-admin-seed'
        )
      ).toBe(true);
    });
  });

  it('库内已有口令时不动它（先启动的一侧胜，另一侧读同一份）', async () => {
    await withSessionSecret(async () => {
      const existing = Buffer.from('existing-cipher-text');
      const { repo, state } = memoryConfigRepo({
        localAdminUsername: 'first-admin',
        localAdminPassword: existing,
      });

      await expect(
        seedLocalAdminCredentialFromEnv({
          env: { PORTAL_ADMIN_USERNAME: 'second-admin', PORTAL_ADMIN_PASSWORD: 'another-pass' },
          repo,
        })
      ).resolves.toBe('exists');

      expect(state.calls.write).toBe(0);
      expect(state.values.localAdminUsername).toBe('first-admin');
      expect(state.values.localAdminPassword).toBe(existing);
    });
  });

  it('开关已是 off 时不再把 .env 的口令「复活」回来', async () => {
    await withSessionSecret(async () => {
      const { repo, state } = memoryConfigRepo({ localAdminMode: 'off' });

      await expect(seedLocalAdminCredentialFromEnv({ env: SEED_ENV, repo })).resolves.toBe(
        'exists'
      );
      expect(state.calls.write).toBe(0);
      expect(state.values.localAdminPassword).toBeUndefined();
    });
  });

  it('写库抛错时降级为 failed，不把启动带崩', async () => {
    await withSessionSecret(async () => {
      const { repo } = memoryConfigRepo();
      const failing = {
        ...repo,
        async seedIfEmpty() {
          throw new Error('db down');
        },
      };

      await expect(
        seedLocalAdminCredentialFromEnv({ env: SEED_ENV, repo: failing })
      ).resolves.toBe('failed');
    });
  });
});
