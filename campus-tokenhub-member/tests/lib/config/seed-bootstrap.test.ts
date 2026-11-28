import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { applyOverlay } from '@/lib/config/overlay';
import { validateAuthSectionErrors, decideStartupAuth } from '@/lib/config/auth-validate';
import { storedConfig } from '../../helpers/config';

/** 复现「首次部署」：deploy/init/010-login-config.sql 写进 DB 的那些列 + 只有 secret 走 env */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'seed-bootstrap-test-session-secret-32',
  PUBLIC_BASE_URL: 'https://portal.example.edu/tokenhub/portal',
  OAUTH2_CLIENT_SECRET: 'secret-from-env-only',
};

const SEEDED = {
  provider: 'oauth2' as const,
  oauth2AuthorizationEndpoint:
    'https://ai.edu.tencent.com/learning/#/login/oauth2?corp_code=dynl7sgpptcvye1b',
  oauth2TokenEndpoint: 'https://eduplatform.translator.qq.com/aie/oauth2/access_token',
  oauth2UserInfoEndpoint: 'https://eduplatform.translator.qq.com/aie/oauth2/user_info',
  oauth2ClientId: '1010',
  oauth2Scopes: 'openid profile email',
  oauth2TokenAuthMethod: 'client_secret_post' as const,
  oauth2UserInfoTokenCarrier: 'query' as const,
  oauth2FieldMapSubject: '{school_id}:{user_id}',
  oauth2FieldMapName: 'user_name',
  oauth2FieldMapSchoolCode: 'school_id',
  oauth2FieldMapSchoolName: 'school_name',
  oauth2FieldMapRoles: 'role_name',
};

describe('首次部署：初始化 SQL 写 DB + client_secret 走 env', () => {
  it('不写 AUTH_PROVIDER 也能通过启动强校验，secret 由 env 兜底', () => {
    const base = loadConfig(BASE_ENV);
    expect(base.auth.provider).toBe('oauth2');

    const merged = applyOverlay(base, storedConfig(SEEDED));

    expect(validateAuthSectionErrors(merged.auth, 'production')).toEqual([]);
    expect(merged.auth.oauth2.clientId).toBe('1010');
    expect(merged.auth.oauth2.clientSecret).toBe('secret-from-env-only');
    expect(merged.auth.oauth2.tokenAuthMethod).toBe('client_secret_post');
    expect(merged.auth.oauth2.userInfoTokenCarrier).toBe('query');
    expect(merged.auth.oauth2.fieldMap.subject).toBe('{school_id}:{user_id}');
  });

  it('DB 里有密钥时 DB 优先，env 只当兜底', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(
      base,
      storedConfig({ ...SEEDED, oauth2ClientSecret: 'secret-from-db' })
    );
    expect(merged.auth.oauth2.clientSecret).toBe('secret-from-db');
  });

  it('密钥两处都没有时校验层点名 Client Secret，但启动层只对协议非法 fail（仍能进设置页补）', () => {
    const base = loadConfig({
      ...BASE_ENV,
      OAUTH2_CLIENT_SECRET: '',
    });
    const merged = applyOverlay(base, storedConfig(SEEDED));
    expect(validateAuthSectionErrors(merged.auth, 'production')).toEqual([
      { key: 'oauth2ClientSecret', message: 'Client Secret 不能为空' },
    ]);
    // 实测行为：缺密钥只 warn，不拦启动——避免首部署因为一个密钥就起不来、连设置页都进不去
    expect(
      decideStartupAuth({ overlayLoaded: true, provider: merged.auth.provider, nodeEnv: 'production' })
    ).toBe('ok');
  });
});
