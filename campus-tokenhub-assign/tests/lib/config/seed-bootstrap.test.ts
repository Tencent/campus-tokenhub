import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { applyOverlay } from '@/lib/config/overlay';
import { validateAuthSectionErrors, decideStartupAuth } from '@/lib/config/auth-validate';
import { storedConfig } from '../../helpers/config';

/**
 * 复现「首次部署」：`deploy/init/010-login-config.sql` 写入 SSO 端点与映射，
 * client_secret 不在 SQL 里（密文与部署机密钥绑定），只能部署后在设置页填一次。
 *
 * 运行期配置只存数据库，因此不再有「secret 走 env 兜底」这条路径。
 */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'admin-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'seed-bootstrap-test-session-secret-32',
  PUBLIC_BASE_URL: 'https://portal.example.edu/tokenhub/portal',
};

const SEEDED = {
  provider: 'oauth2' as const,
  oauth2AuthorizationEndpoint:
    'https://idp.example.edu/learning/#/login/oauth2?corp_code=example',
  oauth2TokenEndpoint: 'https://idp.example.edu/oauth2/access_token',
  oauth2UserInfoEndpoint: 'https://idp.example.edu/oauth2/user_info',
  oauth2ClientId: 'example-client',
  oauth2Scopes: 'openid profile email',
  oauth2TokenAuthMethod: 'client_secret_post' as const,
  oauth2UserInfoTokenCarrier: 'query' as const,
  oauth2FieldMapSubject: '{school_id}:{user_id}',
  oauth2FieldMapName: 'user_name',
  oauth2FieldMapSchoolCode: 'school_id',
  oauth2FieldMapSchoolName: 'school_name',
  oauth2FieldMapRoles: 'role_name',
};

describe('首次部署：初始化 SQL 写库 + secret 由设置页填写', () => {
  it('种子写入后，secret 在设置页填一次即校验通过', () => {
    const merged = applyOverlay(
      loadConfig(BASE_ENV),
      storedConfig({ ...SEEDED, oauth2ClientSecret: 'secret-from-settings' })
    );

    expect(validateAuthSectionErrors(merged.auth, 'production')).toEqual([]);
    expect(merged.auth.oauth2.clientId).toBe('example-client');
    expect(merged.auth.oauth2.clientSecret).toBe('secret-from-settings');
    expect(merged.auth.oauth2.tokenAuthMethod).toBe('client_secret_post');
    expect(merged.auth.oauth2.userInfoTokenCarrier).toBe('query');
    expect(merged.auth.oauth2.fieldMap.subject).toBe('{school_id}:{user_id}');
  });

  it('secret 未填时校验层点名 Client Secret，但不拦启动（还能进设置页补）', () => {
    const merged = applyOverlay(loadConfig(BASE_ENV), storedConfig(SEEDED));

    expect(validateAuthSectionErrors(merged.auth, 'production')).toEqual([
      { key: 'oauth2ClientSecret', message: 'Client Secret 不能为空' },
    ]);
    expect(merged.auth.oauth2.clientSecret).toBe('');
    // 缺密钥只 warn，不拦启动：否则首部署连设置页都进不去
    expect(
      decideStartupAuth({
        overlayLoaded: true,
        provider: merged.auth.provider,
        nodeEnv: 'production',
      })
    ).toBe('ok');
  });

  it('环境变量里的 OAUTH2_CLIENT_SECRET 不再生效', () => {
    const merged = applyOverlay(
      loadConfig({ ...BASE_ENV, OAUTH2_CLIENT_SECRET: 'ignored-by-config' }),
      storedConfig(SEEDED)
    );

    expect(merged.auth.oauth2.clientSecret).toBe('');
    expect(validateAuthSectionErrors(merged.auth, 'production')).toHaveLength(1);
  });
});
