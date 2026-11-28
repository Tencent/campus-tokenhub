import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';

/**
 * 统一采买站的测试辅助。
 *
 * 历史上这个文件服务于成员自购功能（申请单内存仓库、腾讯云 mock 客户端），
 * 拆分后统一采买站不再有成员模块，这里只保留「构造带会话的请求」与「重置环境变量」
 * 两项通用能力。文件名沿用，避免大范围改 import。
 */

export const membersBaseEnv: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
  PUBLIC_BASE_URL: 'http://portal.test',
};

/** 清掉与本功能相关的环境变量，避免用例之间串味。 */
export function resetMembersEnv(extra: Record<string, string> = {}): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('MEMBER_') ||
      key.startsWith('TENCENTCLOUD_') ||
      key === 'PORTAL_DATA_DIR' ||
      // 单测不连真实数据库：存储层全部用内存 repo 注入
      key === 'PORTAL_DATABASE_URL' ||
      key === 'DATABASE_URL'
    ) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, membersBaseEnv, extra);
  resetConfigCache();
}

export type RequestOptions = {
  sub?: string;
  name?: string;
  email?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  origin?: string;
};

export async function memberRequest(
  url: string,
  options: RequestOptions = {}
): Promise<Request> {
  const token = await signSession({
    sub: options.sub ?? '7:17915',
    email: options.email ?? '',
    name: options.name ?? '张三',
    octafuseUserId: 'gw-1',
  });

  return new Request(url, {
    method: options.method ?? 'POST',
    headers: {
      cookie: `portal_session=${token}`,
      origin: options.origin ?? 'http://portal.test',
      host: 'portal.test',
      'content-type': 'application/json',
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
