import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sanitizeNextPath } from '@/lib/auth/login';
import {
  OidcError,
  buildAuthorizationUrl,
  completeAuthorization,
  createOidcTx,
  createPkcePair,
  signOidcTx,
  verifyOidcTx,
  type OidcDeps,
} from '@/lib/auth/providers/oidc';

const auth = {
  issuer: 'https://idp.example.edu',
  clientId: 'portal-client',
  clientSecret: 'client-secret',
  redirectUri: 'https://portal.example.edu/api/auth/callback',
};

const TX_SECRET = 'oidc-tx-secret-that-is-long-enough';

/** 一次完整的「换 token + 验签」桩，claims 可以按用例覆盖 */
function stubDeps(claims: Record<string, unknown> = {}): OidcDeps {
  return {
    exchangeToken: async () => 'stub.id.token',
    verifyIdToken: async () => ({ sub: 's-1', email: 'a@school.edu', name: '张三', ...claims }),
  };
}

async function expectOidcError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(OidcError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('PKCE', () => {
  it('challenge 是 verifier 的 SHA256 base64url', async () => {
    const { codeVerifier, codeChallenge } = await createPkcePair();
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');

    expect(codeChallenge).toBe(expected);
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
});

describe('buildAuthorizationUrl', () => {
  it('带齐 code 流程参数，含 S256 与 state/nonce', async () => {
    const tx = await createOidcTx('/keys');
    const url = new URL(buildAuthorizationUrl(auth, tx));

    expect(url.origin).toBe('https://idp.example.edu');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('portal-client');
    expect(url.searchParams.get('redirect_uri')).toBe(auth.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe(tx.state);
    expect(url.searchParams.get('nonce')).toBe(tx.nonce);
    expect(url.searchParams.get('code_challenge')).toBe(tx.codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('issuer 末尾带斜杠也不会拼出双斜杠', async () => {
    const tx = await createOidcTx('/overview');
    const url = new URL(buildAuthorizationUrl({ ...auth, issuer: 'https://idp.example.edu/' }, tx));

    expect(url.pathname).toBe('/authorize');
  });
});

describe('oidc_tx 签名 Cookie', () => {
  it('签发的 state/nonce/verifier/next 可原样取回', async () => {
    const tx = await createOidcTx('/playground');
    const token = await signOidcTx(tx, TX_SECRET);
    const restored = await verifyOidcTx(token, TX_SECRET);

    expect(restored).toEqual({
      state: tx.state,
      nonce: tx.nonce,
      codeVerifier: tx.codeVerifier,
      next: '/playground',
    });
  });

  it('换密钥或被篡改时返回 null（视为过期）', async () => {
    const tx = await createOidcTx('/overview');
    const token = await signOidcTx(tx, TX_SECRET);

    await expect(verifyOidcTx(token, `${TX_SECRET}-other`)).resolves.toBeNull();
    await expect(verifyOidcTx('broken.token.value', TX_SECRET)).resolves.toBeNull();
    await expect(verifyOidcTx(null, TX_SECRET)).resolves.toBeNull();
  });
});

describe('completeAuthorization', () => {
  it('换取身份：sub/email/name，且真的用了 PKCE verifier', async () => {
    const tx = await createOidcTx('/overview');
    let usedVerifier = '';

    const identity = await completeAuthorization({
      auth,
      tx,
      callback: { code: 'auth-code', state: tx.state },
      deps: {
        exchangeToken: async (params) => {
          usedVerifier = params.codeVerifier;
          expect(params.code).toBe('auth-code');
          expect(params.redirectUri).toBe(auth.redirectUri);
          return 'stub.id.token';
        },
        verifyIdToken: async () => ({ sub: 's-1', email: 'a@school.edu', name: '张三', nonce: tx.nonce }),
      },
    });

    expect(identity).toEqual({ sub: 's-1', email: 'a@school.edu', name: '张三' });
    expect(usedVerifier).toBe(tx.codeVerifier);
  });

  it('name 缺失时回退到 preferred_username', async () => {
    const tx = await createOidcTx('/overview');
    const identity = await completeAuthorization({
      auth,
      tx,
      callback: { code: 'c', state: tx.state },
      deps: stubDeps({ name: undefined, preferred_username: 'zhangsan', nonce: tx.nonce }),
    });

    expect(identity.name).toBe('zhangsan');
  });

  it('state 不匹配被拒', async () => {
    const tx = await createOidcTx('/overview');

    await expectOidcError(
      completeAuthorization({
        auth,
        tx,
        callback: { code: 'c', state: 'forged-state' },
        deps: stubDeps({ nonce: tx.nonce }),
      }),
      'state_mismatch'
    );
  });

  it('nonce 不匹配被拒（防重放）', async () => {
    const tx = await createOidcTx('/overview');

    await expectOidcError(
      completeAuthorization({
        auth,
        tx,
        callback: { code: 'c', state: tx.state },
        deps: stubDeps({ nonce: 'other-nonce' }),
      }),
      'nonce_mismatch'
    );
  });

  it('IdP 返回 error 时直接拒绝，不去换 token', async () => {
    const tx = await createOidcTx('/overview');
    let exchanged = false;

    await expectOidcError(
      completeAuthorization({
        auth,
        tx,
        callback: { error: 'access_denied' },
        deps: {
          exchangeToken: async () => {
            exchanged = true;
            return 'x';
          },
        },
      }),
      'access_denied'
    );
    expect(exchanged).toBe(false);
  });

  it('事务 Cookie 已过期（tx 为 null）被拒', async () => {
    await expectOidcError(
      completeAuthorization({ auth, tx: null, callback: { code: 'c', state: 's' } }),
      'tx_missing'
    );
  });

  it('换 token 失败映射为 token_exchange_failed', async () => {
    const tx = await createOidcTx('/overview');

    await expectOidcError(
      completeAuthorization({
        auth,
        tx,
        callback: { code: 'c', state: tx.state },
        deps: {
          exchangeToken: async () => {
            throw new Error('network down');
          },
          verifyIdToken: async () => ({}),
        },
      }),
      'token_exchange_failed'
    );
  });

  it('id_token 验签失败映射为 id_token_invalid', async () => {
    const tx = await createOidcTx('/overview');

    await expectOidcError(
      completeAuthorization({
        auth,
        tx,
        callback: { code: 'c', state: tx.state },
        deps: {
          exchangeToken: async () => 'id.token',
          verifyIdToken: async () => {
            throw new Error('bad signature');
          },
        },
      }),
      'id_token_invalid'
    );
  });
});

describe('sanitizeNextPath', () => {
  it('站内相对路径原样保留', () => {
    expect(sanitizeNextPath('/keys')).toBe('/keys');
    expect(sanitizeNextPath('/models?tab=image')).toBe('/models?tab=image');
  });

  it('站外 URL 与协议相对 URL 一律回落到 /overview', () => {
    expect(sanitizeNextPath('https://evil.example.com')).toBe('/overview');
    expect(sanitizeNextPath('//evil.example.com/x')).toBe('/overview');
    expect(sanitizeNextPath('/\\evil.example.com')).toBe('/overview');
    expect(sanitizeNextPath('javascript:alert(1)')).toBe('/overview');
    expect(sanitizeNextPath('')).toBe('/overview');
    expect(sanitizeNextPath(null)).toBe('/overview');
  });

  it('缺省落点可替换为当前模式首页', () => {
    expect(sanitizeNextPath(null, '/members')).toBe('/members');
    expect(sanitizeNextPath('', '/members')).toBe('/members');
    expect(sanitizeNextPath(undefined, '/members')).toBe('/members');
  });

  it('显式合法路径优先于模式兜底', () => {
    expect(sanitizeNextPath('/models/abc', '/members')).toBe('/models/abc');
    expect(sanitizeNextPath('/overview', '/members')).toBe('/overview');
  });

  it('换成模式兜底后仍挡住站外与协议相对地址', () => {
    expect(sanitizeNextPath('https://evil.example.com', '/members')).toBe('/members');
    expect(sanitizeNextPath('//evil.example.com/x', '/members')).toBe('/members');
    expect(sanitizeNextPath('/\\evil.example.com', '/members')).toBe('/members');
  });
});
