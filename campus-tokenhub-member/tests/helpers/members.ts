import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetConfigCache } from '@/lib/config';
import {
  resetAdminRosterCache,
  setAdminRosterRepoOverride,
  type AdminRosterRepo,
} from '@/lib/admin/roster';
import {
  setMemberApplicationRepo,
  type MemberApplicationRepo,
} from '@/lib/members/store';
import type { MemberApplication } from '@/lib/members/types';
import { resetOrganizationClientCache } from '@/lib/tencent/factory';
import { signSession } from '@/lib/auth/session';

/** `memberRequest` 默认签发的身份；管理员名单桩默认只放它进去 */
export const DEFAULT_MEMBER_SUB = '7:17915';


/** 内存版管理员名单：单测不连数据库，行为与表实现一致（读全量 → 改 → 写回） */
export function createMemoryAdminRoster(initial: string[] = []): AdminRosterRepo {
  let subs = [...new Set(initial)];
  return {
    async list() {
      return [...subs];
    },
    async replaceAll(next: string[]) {
      subs = [...new Set(next)];
    },
    async add(entries: string[]) {
      subs = [...new Set([...subs, ...entries])];
    },
    async remove(sub: string) {
      subs = subs.filter((item) => item !== sub);
    },
  };
}

/**
 * 把当前用例的管理员名单设成 `subs`。
 *
 * 管理员只有一个权威来源（`portal_shared.admins`），原来的 `ADMIN_EMAILS` 邮箱白名单
 * 已经移除，所以单测里「让某个身份成为管理员」只能通过这里注入名单，
 * 不再靠 email 命中——否则测试断言的提权路径与线上不一致。
 */
export function stubAdminRoster(subs: string[] = [DEFAULT_MEMBER_SUB]): AdminRosterRepo {
  const repo = createMemoryAdminRoster(subs);
  setAdminRosterRepoOverride(repo);
  resetAdminRosterCache();
  return repo;
}

/** 内存版申请单存储：单测不连数据库，行为与表实现一致（读全量 → 改 → 写回） */
export function createMemoryApplicationRepo(
  initial: MemberApplication[] = []
): MemberApplicationRepo {
  let apps = initial.map((app) => ({ ...app }));
  let chain: Promise<unknown> = Promise.resolve();

  return {
    async read() {
      await chain.catch(() => undefined);
      return apps.map((app) => ({ ...app }));
    },
    mutate<T>(fn: (list: MemberApplication[]) => T | Promise<T>): Promise<T> {
      const run = chain.then(async () => {
        const draft = apps.map((app) => ({ ...app }));
        const result = await fn(draft);
        apps = draft;
        return result;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

export const membersBaseEnv: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'pw',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
  PUBLIC_BASE_URL: 'http://portal.test',
  MEMBER_ACCOUNT_PROVIDER: 'mock',
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
  resetAdminRosterCache();
  // 名单桩回到默认（生产 pg 实现）：上一个用例注入的管理员不会漏进下一个用例。
  // 需要管理员的用例自己调 stubAdminRoster()。
  setAdminRosterRepoOverride(null);
  // 每个用例一份干净的申请单存储
  setMemberApplicationRepo(createMemoryApplicationRepo());
  resetOrganizationClientCache();
}

/** 每个用例独立的落盘目录，互不污染。 */
export async function makeDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'portal-members-api-'));
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
    sub: options.sub ?? DEFAULT_MEMBER_SUB,
    email: options.email ?? '',
    name: options.name ?? '张三',
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
