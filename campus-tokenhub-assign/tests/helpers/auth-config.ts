import type { AppConfig } from '@/lib/config';

type OAuth2Patch = Partial<AppConfig['auth']['oauth2']>;

/**
 * 模拟 overlay 加载后的效果：把「数据库里已保存的登录配置」叠到 env base 上。
 *
 * 运行期配置改为只存数据库后，测试不能再靠环境变量构造 SSO 参数，
 * 必须显式覆盖 AppConfig —— 等价于「设置页已经配好」。
 */
export function withOauth2(base: AppConfig, patch: OAuth2Patch = {}): AppConfig {
  return {
    ...base,
    auth: {
      ...base.auth,
      provider: 'oauth2',
      oauth2: { ...base.auth.oauth2, ...patch },
    },
  };
}

export function withCas(
  base: AppConfig,
  patch: Partial<AppConfig['auth']['cas']> = {}
): AppConfig {
  return {
    ...base,
    auth: { ...base.auth, provider: 'cas', cas: { ...base.auth.cas, ...patch } },
  };
}

export function withDefaults(
  base: AppConfig,
  patch: Partial<AppConfig['defaults']>
): AppConfig {
  return { ...base, defaults: { ...base.defaults, ...patch } };
}

export function withPortal(
  base: AppConfig,
  patch: Partial<AppConfig['portal']>
): AppConfig {
  return { ...base, portal: { ...base.portal, ...patch } };
}

/** OAuth2 五项必填都就绪的覆盖值 */
export const READY_OAUTH2: OAuth2Patch = {
  authorizationEndpoint: 'https://idp.example.com/oauth2/authorize',
  tokenEndpoint: 'https://idp.example.com/oauth2/token',
  userInfoEndpoint: 'https://idp.example.com/oauth2/userinfo',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};
