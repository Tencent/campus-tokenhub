/**
 * 配置探测：需要外部系统才能确认的事实，统一走这里。
 *
 * 探测只用「草稿值 + 当前已存值」，不写库、不写日志；失败一律映射成可读中文与稳定 code，
 * 不把腾讯云原始错误码抛给页面。
 *
 * 与统一采买站（assign）的差异：成员站没有网关，因此没有「计费币种」探测；
 * 保留的是腾讯云 CAM 凭据探测（成员账号建号的前置条件）。
 */

import { getConfig } from '@/lib/config';
import {
  TencentApiError,
  createOrganizationClient,
  type OrganizationClient,
} from '@/lib/tencent/organization';

export type ProbeGroup = 'tencent' | 'admin';

/** 探测入参只列真正需要的字段 */
export type ProbeDraft = {
  secretId?: string;
  secretKey?: string;
  sub?: string;
};

export type ProbeOutcome = {
  ok: boolean;
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
};

export type ProbeClientFactory = (input: { secretId: string; secretKey: string }) => OrganizationClient;

let clientFactoryOverride: ProbeClientFactory | null = null;

/** 管理员身份是否存在；读不到返回 null（未知） */
let adminLookup: (sub: string) => Promise<boolean | null> = async () => null;

export function setProbeDeps(deps: {
  adminLookup?: (sub: string) => Promise<boolean | null>;
}): void {
  if (deps.adminLookup) adminLookup = deps.adminLookup;
}

/** 仅测试用：恢复默认探测依赖 */
export function resetProbeDeps(): void {
  adminLookup = async () => null;
  clientFactoryOverride = null;
}

/** 仅测试用：替换腾讯云客户端工厂 */
export function setProbeClientFactory(factory: ProbeClientFactory | null): void {
  clientFactoryOverride = factory;
}

function readString(draft: ProbeDraft, key: keyof ProbeDraft): string {
  const raw = draft[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function mapTencentError(error: unknown): ProbeOutcome {
  if (error instanceof TencentApiError) {
    const code = error.code || '';
    if (/AuthFailure\.(Signature|SecretId|Token)/i.test(code) || /AuthFailure$/i.test(code)) {
      return {
        ok: false,
        code: 'invalid_credential',
        message: '凭据无效或已停用，请检查子账号是否启用、SecretId 与 SecretKey 是否匹配',
      };
    }
    if (/UnauthorizedOperation|AuthFailure\.UnauthorizedOperation/i.test(code)) {
      return {
        ok: false,
        code: 'no_permission',
        message: '该子账号没有 organization 接口权限，请为其授予读取组织节点的权限',
      };
    }
    return {
      ok: false,
      code: 'probe_failed',
      message: '腾讯云返回异常，请稍后重试或联系管理员',
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|超时/i.test(message)) {
    return { ok: false, code: 'probe_timeout', message: '请求腾讯云超时，请检查网络后重试' };
  }
  return { ok: false, code: 'probe_failed', message: '探测失败，请稍后重试' };
}

/**
 * 探测腾讯云 CAM 凭据：能否鉴权、是否有 organization 权限、能否识别根节点。
 *
 * `draft` 里给了值就用草稿（未保存也能测），没给则用已存配置。
 */
export async function probeTencentCredentials(draft: ProbeDraft = {}): Promise<ProbeOutcome> {
  const cfg = getConfig();
  const secretId = readString(draft, 'secretId') || cfg.tencentCloud.secretId;
  const secretKey = readString(draft, 'secretKey') || cfg.tencentCloud.secretKey;

  if (!secretId || !secretKey) {
    return {
      ok: false,
      code: 'not_configured',
      message: '尚未配置腾讯云 CAM 凭据，请先填写 SecretId 与 SecretKey',
    };
  }

  const factory: ProbeClientFactory =
    clientFactoryOverride ??
    (({ secretId: id, secretKey: key }) =>
      createOrganizationClient({
        secretId: id,
        secretKey: key,
        region: cfg.tencentCloud.region,
        endpoint: cfg.tencentCloud.endpoint,
      }));

  try {
    const client = factory({ secretId, secretKey });
    // 只拉第一页：探测只需要判断「能不能连、有没有根节点」
    const result = await client.describeNodes({ maxPages: 1, deadline: Date.now() + 8_000 });
    const roots = result.nodes
      .filter((node) => node.parentId === 0)
      .sort((left, right) => left.nodeId - right.nodeId);

    if (roots.length === 0) {
      return {
        ok: false,
        code: 'root_missing',
        message: '凭据可用，但组织里没有根节点，请确认该子账号属于学校集团账号',
      };
    }

    return {
      ok: true,
      detail: {
        root: { nodeId: roots[0].nodeId, name: roots[0].name },
        nodeCount: result.nodes.length,
        multipleRoots: roots.length > 1,
      },
    };
  } catch (error) {
    return mapTencentError(error);
  }
}

/** 管理员身份探测：查不到只提示「未知身份」，不阻止保存 */
export async function probeAdminIdentity(draft: ProbeDraft = {}): Promise<ProbeOutcome> {
  const sub = readString(draft, 'sub');
  if (!sub) {
    return { ok: false, code: 'invalid_sub', message: '缺少要检测的身份' };
  }

  try {
    const exists = await adminLookup(sub);
    if (exists === null) {
      return {
        ok: true,
        message: '暂时无法确认该身份（共享名单读取失败）',
        detail: { status: 'unknown' },
      };
    }
    return {
      ok: true,
      message: exists ? undefined : '该身份尚未登录过门户，第一次登录后才会生效',
      detail: { status: exists ? 'found' : 'unknown' },
    };
  } catch {
    return {
      ok: true,
      message: '暂时无法确认该身份是否登录过门户',
      detail: { status: 'unknown' },
    };
  }
}
