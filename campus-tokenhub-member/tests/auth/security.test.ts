import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { SESSION_PURPOSE, verifySession } from '@/lib/auth/session';
import {
  OIDC_TX_PURPOSE,
  buildAuthorizationUrl,
  createOidcTx,
  signOidcTx,
  verifyOidcTx,
} from '@/lib/auth/providers/oidc';
import {
  readableError,
  readSignedErrorDetail,
  sanitizeErrorDetail,
  signErrorDetail,
} from '@/lib/auth/login-errors';

const SECRET = 'cross-purpose-test-secret-that-is-long-enough';

const auth = {
  issuer: 'https://idp.example.edu',
  clientId: 'portal-client',
  redirectUri: 'https://portal.example.edu/api/auth/callback',
};

/** 用同一密钥签一枚不带用途声明的 JWT，模拟任意「合法签名但用途不明」的 token */
function signRaw(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(new TextEncoder().encode(SECRET));
}

describe('C1 会话与 oidc_tx 用途隔离', () => {
  it('oidc_tx 不能冒充 portal_session', async () => {
    const tx = await createOidcTx('/overview');
    const txToken = await signOidcTx(tx, SECRET);

    await expect(verifySession(txToken, { secret: SECRET })).resolves.toBeNull();
  });

  it('portal_session 不能冒充 oidc_tx', async () => {
    const token = await signRaw({
      purpose: SESSION_PURPOSE,
      sub: 'student-001',
      email: 'a@school.edu',
      name: '张三',
      octafuse_user_id: null,
      state: 'forged-state',
      nonce: 'forged-nonce',
      codeVerifier: 'forged-verifier',
      next: '/overview',
    });

    await expect(verifyOidcTx(token, SECRET)).resolves.toBeNull();
  });

  it('合法签名但缺 purpose 的 token 不能成为会话', async () => {
    const token = await signRaw({
      sub: 'student-001',
      email: 'a@school.edu',
      name: '张三',
      octafuse_user_id: null,
    });

    await expect(verifySession(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('purpose 正确但 sub 为空的 token 不能成为会话', async () => {
    const token = await signRaw({
      purpose: SESSION_PURPOSE,
      sub: '',
      email: '',
      name: '',
      octafuse_user_id: null,
    });

    await expect(verifySession(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('oidc_tx 声明了独立用途', async () => {
    const tx = await createOidcTx('/overview');
    const token = await signOidcTx(tx, SECRET);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

    expect(payload.purpose).toBe(OIDC_TX_PURPOSE);
    expect(payload.purpose).not.toBe(SESSION_PURPOSE);
  });
});

describe('I2 OIDC 授权端点取自发现文档', () => {
  it('支持 IdP 自定义授权端点（Keycloak / Azure 路径）', async () => {
    const tx = await createOidcTx('/keys');
    const url = new URL(
      buildAuthorizationUrl(auth, tx, 'https://idp.example.edu/protocol/openid-connect/auth')
    );

    expect(url.origin).toBe('https://idp.example.edu');
    expect(url.pathname).toBe('/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('portal-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('授权端点与 issuer 不同源时拒绝', async () => {
    const tx = await createOidcTx('/keys');

    expect(() => buildAuthorizationUrl(auth, tx, 'https://evil.example.com/authorize')).toThrow();
  });

  it('不传端点时仍回落到 {issuer}/authorize', async () => {
    const tx = await createOidcTx('/keys');
    expect(new URL(buildAuthorizationUrl(auth, tx)).pathname).toBe('/authorize');
  });
});

describe('M7 登录错误码白名单', () => {
  it('已知错误码返回固定文案', () => {
    expect(readableError('tx_missing')).toBe('登录已超时，请重新登录。');
  });

  it('原型链上的 key 不会被当作文案渲染', () => {
    expect(readableError('__proto__')).toBe('登录失败，请重试。');
    expect(readableError('constructor')).toBe('登录失败，请重试。');
  });

  it('未知错误码不回显原文，避免站内钓鱼话术', () => {
    expect(readableError('请将密码发送至 attacker@example.com')).toBe('登录失败，请重试。');
  });

  it('Mock 的中文原因仍可读，但控制字符被过滤', () => {
    expect(readableError('邮箱格式不对')).toBe('邮箱格式不对');
    expect(readableError('出错\u0007了')).toBe('出错了');
  });
});

describe('M8 登录真实报错回显', () => {
  it('服务端签名的 detail 可回显', async () => {
    const token = await signErrorDetail(SECRET, 'tx_missing', '登录事务 Cookie 缺失或已过期');

    await expect(readSignedErrorDetail(SECRET, token, 'tx_missing')).resolves.toBe(
      '登录事务 Cookie 缺失或已过期'
    );
  });

  it('错误码不符、密钥不符、用途不符都不回显', async () => {
    const token = await signErrorDetail(SECRET, 'tx_missing', '真实原因');
    await expect(readSignedErrorDetail(SECRET, token, 'state_mismatch')).resolves.toBeNull();
    await expect(
      readSignedErrorDetail('another-secret-that-is-long-enough', token, 'tx_missing')
    ).resolves.toBeNull();

    const wrongPurpose = await signRaw({
      purpose: 'portal-session',
      code: 'tx_missing',
      detail: '钓鱼提示',
    });
    await expect(readSignedErrorDetail(SECRET, wrongPurpose, 'tx_missing')).resolves.toBeNull();
  });

  it('真实报错里的控制字符、凭据与超长内容会被收敛', () => {
    const cleaned = sanitizeErrorDetail(
      `token 端点返回异常：client_secret=abc123 Bearer eyJhbGciOi\u0007 ${'a'.repeat(400)}`
    );

    expect(cleaned).not.toContain('abc123');
    expect(cleaned).not.toContain('eyJhbGciOi');
    expect(cleaned).not.toContain('\u0007');
    expect(cleaned.length).toBeLessThanOrEqual(300);
  });
});
