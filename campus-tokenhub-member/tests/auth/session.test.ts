import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import {
  SESSION_COOKIE,
  buildSessionCookie,
  clearLegacyRootSessionCookie,
  clearSessionCookie,
  signSession,
  sessionTokensFromCookieHeader,
  verifyAnySession,
  verifySession,
} from '@/lib/auth/session';

const SECRET = 'unit-test-secret-that-is-long-enough';

const identity = {
  sub: 'student-001',
  email: 'zhangsan@school.edu',
  name: '张三',
};

/** buildSessionCookie 要读 config，这里给一套最小可用 env */
function setEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789',
    OCTAFUSE_PROXY_BASE: 'http://127.0.0.1:8790',
    // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
    OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
    SESSION_SECRET: SECRET,
    ...overrides,
  });
  resetConfigCache();
}

afterEach(() => {
  delete process.env.SESSION_TTL_HOURS;
  delete process.env.COOKIE_SECURE;
  delete process.env.PORTAL_COOKIE_PATH;
  resetConfigCache();
});

beforeEach(() => {
  setEnv();
});

describe('signSession / verifySession', () => {
  it('签发后可验签取回身份（写入端不含网关用户 ID）', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session).not.toBeNull();
    expect(session).toMatchObject({
      sub: 'student-001',
      email: 'zhangsan@school.edu',
      name: '张三',
      octafuse_user_id: null,
    });
    expect(session!.exp - session!.iat).toBe(8 * 3600);
  });

  it('member 侧写入端不产出 octafuse_user_id，读取端解析为 null', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.octafuse_user_id).toBeNull();
  });

  it('篡改 payload 后验签失败', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const [header, payload, signature] = token.split('.');

    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.sub = 'attacker';
    const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    const forged = `${header}.${forgedPayload}.${signature}`;

    await expect(verifySession(forged, { secret: SECRET })).resolves.toBeNull();
  });

  it('换一个密钥签的 token 验签失败', async () => {
    const token = await signSession(identity, { secret: SECRET });
    await expect(verifySession(token, { secret: `${SECRET}-another` })).resolves.toBeNull();
  });

  it('过期 token 被拒', async () => {
    const token = await signSession(identity, {
      secret: SECRET,
      ttlHours: 1,
      now: new Date('2020-01-01T00:00:00Z'),
    });

    await expect(verifySession(token, { secret: SECRET })).resolves.toBeNull();
  });

  it('非法格式不抛异常，直接返回 null', async () => {
    await expect(verifySession('not-a-jwt', { secret: SECRET })).resolves.toBeNull();
  });
});

describe('school_name 声明', () => {
  it('签发时带校名，验签后可取回', async () => {
    const token = await signSession({ ...identity, schoolName: '示例学校' }, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.school_name).toBe('示例学校');
  });

  it('认证方没返回校名时不写 claim', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.school_name).toBeUndefined();
  });
});

describe('admin 声明', () => {
  it('签发时打标则验签后 admin 为 true', async () => {
    const token = await signSession({ ...identity, admin: true }, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.admin).toBe(true);
  });

  it('未打标的会话 admin 为 false（默认值，不写 claim）', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.admin).toBe(false);
  });

  it('篡改 payload 把 admin 改成 true 后验签失败', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const [header, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    decoded.admin = true;
    const forgedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    await expect(
      verifySession(`${header}.${forgedPayload}.${signature}`, { secret: SECRET })
    ).resolves.toBeNull();
  });

  it('admin 声明为非布尔类型时不算管理员（但签名有效）', async () => {
    // 用同一密钥、同一 purpose 手工签一枚 admin 为字符串的 token：
    // 签名合法，只有 claim 类型不对，用来验证服务端不会把任意真值当管理员。
    const { SignJWT } = await import('jose');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      purpose: 'portal-session',
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      octafuse_user_id: null,
      admin: 'true',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET));

    const session = await verifySession(token, { secret: SECRET });

    expect(session).not.toBeNull();
    expect(session!.admin).toBe(false);
  });
});

describe('login_method 声明（引导期账号密码登录的失效依据）', () => {
  it('密码登录签发的会话带 login_method=password', async () => {
    const token = await signSession(
      { ...identity, admin: true, loginMethod: 'password' },
      { secret: SECRET }
    );
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.login_method).toBe('password');
  });

  it('SSO 会话不写该 claim', async () => {
    const token = await signSession(identity, { secret: SECRET });
    const session = await verifySession(token, { secret: SECRET });

    expect(session!.login_method).toBeUndefined();
  });

  it('claim 为非 password 的字符串时视为缺席（签名有效但不被当成密码会话）', async () => {
    const { SignJWT } = await import('jose');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      purpose: 'portal-session',
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      octafuse_user_id: null,
      login_method: 'sso',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET));

    const session = await verifySession(token, { secret: SECRET });

    expect(session).not.toBeNull();
    expect(session!.login_method).toBeUndefined();
  });
});

describe('buildSessionCookie', () => {  it('集中给齐 Cookie 属性，TTL 取自 SESSION_TTL_HOURS', async () => {
    setEnv({ SESSION_TTL_HOURS: '4', COOKIE_SECURE: 'true' });

    const cookie = buildSessionCookie('token-value');

    expect(cookie.name).toBe(SESSION_COOKIE);
    expect(cookie.name).toBe('portal_session');
    expect(cookie.value).toBe('token-value');
    expect(cookie.options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
      maxAge: 4 * 3600,
    });
  });

  it('COOKIE_SECURE 默认 false，HTTP 部署下不会丢会话', () => {
    setEnv();

    expect(buildSessionCookie('t').options.secure).toBe(false);
    expect(buildSessionCookie('t').options.maxAge).toBe(8 * 3600);
  });

  it('清除 Cookie 时值为空且 maxAge 为 0', () => {
    setEnv();

    const cookie = clearSessionCookie();

    expect(cookie.name).toBe('portal_session');
    expect(cookie.value).toBe('');
    expect(cookie.options.maxAge).toBe(0);
  });
});

describe('Cookie 作用域（同域双站互认的前提）', () => {
  afterEach(() => {
    resetConfigCache();
    for (const key of ['PORTAL_COOKIE_DOMAIN', 'PORTAL_COOKIE_PATH']) delete process.env[key];
  });

  it('默认不写 Domain（host-only），path 为 /', () => {
    process.env.SESSION_SECRET = SECRET;
    resetConfigCache();

    const cookie = buildSessionCookie('token');

    expect(cookie.options.domain).toBeUndefined();
    expect(cookie.options.path).toBe('/');
  });

  it('设了父域时原样写入 Domain', () => {
    Object.assign(process.env, { SESSION_SECRET: SECRET, PORTAL_COOKIE_DOMAIN: '.school.edu.cn' });
    resetConfigCache();

    expect(buildSessionCookie('token').options.domain).toBe('.school.edu.cn');
  });

  it('多个前导点归一成一个', () => {
    Object.assign(process.env, { SESSION_SECRET: SECRET, PORTAL_COOKIE_DOMAIN: '..school.edu.cn' });
    resetConfigCache();

    expect(buildSessionCookie('token').options.domain).toBe('.school.edu.cn');
  });

  it('path 去掉尾斜杠，便于两站共用同一个前缀', () => {
    Object.assign(process.env, { SESSION_SECRET: SECRET, PORTAL_COOKIE_PATH: '/tokenhub/' });
    resetConfigCache();

    expect(buildSessionCookie('token').options.path).toBe('/tokenhub');
  });

  it('非法 path（无前导斜杠）回落到 /，而不是让所有人登录不上', () => {
    Object.assign(process.env, { SESSION_SECRET: SECRET, PORTAL_COOKIE_PATH: 'tokenhub' });
    resetConfigCache();

    expect(buildSessionCookie('token').options.path).toBe('/');
  });

  it('清除 Cookie 时作用域与写入时一致（否则浏览器删不掉）', () => {
    Object.assign(process.env, {
      SESSION_SECRET: SECRET,
      PORTAL_COOKIE_DOMAIN: '.school.edu.cn',
      PORTAL_COOKIE_PATH: '/tokenhub',
    });
    resetConfigCache();

    const set = buildSessionCookie('token');
    const clear = clearSessionCookie();

    expect(clear.options.domain).toBe(set.options.domain);
    expect(clear.options.path).toBe(set.options.path);
    expect(clear.options.maxAge).toBe(0);
  });
});

describe('verifyAnySession（同名 Cookie 并存时逐个验签）', () => {
  const identity = {
    sub: '100051:1012173',
    email: 'a@school.edu',
    name: '张三',
    ...(process.env.PORTAL_TEST_OCTAFUSE === '1' ? {} : {}),
  } as never;

  it('第一个是旧密钥签的、第二个有效时，取第二个', async () => {
    const stale = await signSession(identity, { secret: 'old-secret-from-previous-deploy' } as never);
    const fresh = await signSession(identity, { secret: SECRET });

    const session = await verifyAnySession([stale, fresh], { secret: SECRET });

    expect(session?.sub).toBe('100051:1012173');
  });

  it('全部无效时返回 null', async () => {
    const stale = await signSession(identity, { secret: 'another-old-secret' } as never);

    expect(await verifyAnySession([stale], { secret: SECRET })).toBeNull();
    expect(await verifyAnySession([], { secret: SECRET })).toBeNull();
  });

  it('空值混在中间不影响结果', async () => {
    const fresh = await signSession(identity, { secret: SECRET });

    const session = await verifyAnySession(['', fresh], { secret: SECRET });

    expect(session?.sub).toBe('100051:1012173');
  });
});

describe('sessionTokensFromCookieHeader（同名 Cookie 并存）', () => {
  it('从原始 Cookie 头里取出所有同名值，顺序不变', () => {
    const header = 'portal_session=aaa; NEXT_LOCALE=zh; portal_session=bbb; portal_mode=assign';

    expect(sessionTokensFromCookieHeader(header)).toEqual(['aaa', 'bbb']);
  });

  it('没有该 Cookie 时返回空数组', () => {
    expect(sessionTokensFromCookieHeader('NEXT_LOCALE=zh')).toEqual([]);
    expect(sessionTokensFromCookieHeader(null)).toEqual([]);
    expect(sessionTokensFromCookieHeader(undefined)).toEqual([]);
  });

  it('百分号编码的值会解码', () => {
    expect(sessionTokensFromCookieHeader('portal_session=a%2Eb')).toEqual(['a.b']);
  });

  it('前缀相似但不相同的键不会被误取', () => {
    expect(sessionTokensFromCookieHeader('portal_session_backup=x; portal_session=y')).toEqual(['y']);
  });
});

describe('clearLegacyRootSessionCookie（清旧版本写在根路径的同名 Cookie）', () => {
  it('前缀部署下发一条 Path=/ 的过期 Cookie', () => {
    setEnv({ PORTAL_COOKIE_PATH: '/tokenhub' });
    const headers = new Headers();

    clearLegacyRootSessionCookie({ headers }, buildSessionCookie('token'));

    const header = headers.get('set-cookie') ?? '';
    expect(header).toContain(`${SESSION_COOKIE}=`);
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=0');
  });

  it('根路径部署不需要清理，不回任何 Set-Cookie', () => {
    setEnv({ PORTAL_COOKIE_PATH: '/' });
    const headers = new Headers();

    clearLegacyRootSessionCookie({ headers }, buildSessionCookie('token'));

    expect(headers.get('set-cookie')).toBeNull();
  });
});
