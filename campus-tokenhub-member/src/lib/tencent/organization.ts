/**
 * 腾讯云 organization（集团账号）接口客户端。
 *
 * 只封装门户用到的 5 个 Action：部门列表、建号、绑邮箱手机、查绑定状态、按名回查。
 * 每次调用 8 秒硬超时（`AbortController` + `Promise.race` 双保险），超时不自动重试——
 * 建号不是幂等操作，重试交给管理员走「重名 + Remark 归属判定」那条安全路径。
 */

import type { OrganizationNode } from '@/lib/members/types';
import { signRequest } from './signature';

const API_VERSION = '2021-03-31';
const NODE_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 8_000;

/** 销号比建号慢（要清理成员名下资源），单独给更长的超时 */
const DELETE_TIMEOUT_MS = 30_000;

export class TencentApiError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, message: string, requestId = '') {
    super(message);
    this.name = 'TencentApiError';
    this.code = code;
    this.requestId = requestId;
  }
}

export type OrganizationClientConfig = {
  secretId: string;
  secretKey: string;
  region: string;
  endpoint: string;
  timeoutMs?: number;
};

export type CreateMemberInput = {
  name: string;
  accountName: string;
  nodeId: number;
  policyType: string;
  permissionIds: number[];
  remark: string;
};

export type AddNodeInput = {
  parentNodeId: number;
  name: string;
  /** 误建节点的唯一识别手段，门户固定写 `portal:auto` */
  remark?: string;
};

/** 部门树拉取结果：`truncated` 表示达到页数上限但仍有节点未取回 */
export type OrganizationNodesResult = {
  nodes: OrganizationNode[];
  truncated: boolean;
};

export type BindEmailInput = {
  uin: string;
  email: string;
  countryCode: string;
  phone: string;
};

export type MemberSummary = {
  uin: string;
  name: string;
  remark: string;
};

export type OrganizationClient = {
  /** 供测试与排障区分真实客户端与假客户端 */
  readonly kind: 'tencent' | 'mock';
  describeNodes(options?: {
    maxPages?: number;
    /** 毫秒时间戳：每页调用前检查剩余预算，并按剩余时间收紧单次超时 */
    deadline?: number;
  }): Promise<OrganizationNodesResult>;
  addNode(input: AddNodeInput): Promise<{ nodeId: number; requestId: string }>;
  createMember(input: CreateMemberInput): Promise<{ uin: string; requestId: string }>;
  bindEmail(input: BindEmailInput): Promise<{ bindId: string; requestId: string }>;
  getEmailBindStatus(uin: string): Promise<{ bindStatus: string; requestId: string }>;
  findMemberByName(name: string): Promise<MemberSummary | null>;
  /**
   * 删除成员账号（不是「移出组织」）。
   *
   * 用 `DeleteAccount`：`DeleteOrganizationMembers` 只是把成员移出组织，
   * 对 API 创建的成员会直接被拒（`CreateMemberNotAllowDelete`），因为创建型成员
   * 本来就没有「加入组织」这一步。真正的销号接口是 DeleteAccount，参数 MemberUin 是单值。
   *
   * 幂等：云侧已不存在（`ResourceNotFound.OrganizationMemberNotExist`）时返回
   * `alreadyGone: true` 而不抛错——「云侧删成功、本地写失败」这类中断单重试时必须靠它补正。
   *
   * 走审核的情况（`FailedOperation.MemberAccountDeregisterPending`，官方约 3 个工作日）
   * 返回 `pendingReview: true`，让上层把话说清楚，而不是显示成「已删除」。
   *
   * 前置条件（云侧，非代码可控）：控制台需开启「成员删除许可」，否则返回
   * `UnsupportedOperation.DeleteAccountDisabled`，原样上抛由上层回滚。
   */
  deleteMember(
    uin: string
  ): Promise<{ requestId: string; alreadyGone: boolean; pendingReview: boolean }>;
};

type Deps = {
  fetchImpl?: typeof fetch;
  /** 毫秒时间戳；测试注入固定值，签名才可复现 */
  now?: () => number;
};

type RawResponse = {
  Response?: {
    RequestId?: string;
    Error?: { Code?: string; Message?: string; RequestId?: string };
    [key: string]: unknown;
  };
};

/** 只做一次 HTTP 往返并把腾讯云错误翻成 TencentApiError。 */
async function callOrganization(
  config: OrganizationClientConfig,
  deps: Deps,
  action: string,
  payload: Record<string, unknown>,
  timeoutOverride?: number
): Promise<Record<string, unknown>> {
  if (!config.secretId || !config.secretKey) {
    throw new TencentApiError('not_configured', '腾讯云密钥未配置');
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = (deps.now ?? (() => Date.now()))();
  const timestamp = Math.floor(nowMs / 1000);
  const body = JSON.stringify(payload);
  const signed = signRequest({
    secretId: config.secretId,
    secretKey: config.secretKey,
    host: config.endpoint,
    action,
    payload: body,
    timestamp,
  });

  const controller = new AbortController();
  const timeoutMs = timeoutOverride ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TencentApiError('Timeout', `腾讯云接口超时（${action}）`));
    }, timeoutMs);
  });

  let response: Response;
  try {
    response = await Promise.race([
      fetchImpl(`https://${config.endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: signed.authorization,
          'Content-Type': signed.contentType,
          Host: config.endpoint,
          'X-TC-Action': action,
          'X-TC-Version': API_VERSION,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': config.region,
        },
        body,
        signal: controller.signal,
      }),
      timeout,
    ]);
  } catch (error) {
    if (error instanceof TencentApiError) throw error;
    throw new TencentApiError(
      'NetworkError',
      `无法连接腾讯云：${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  let json: RawResponse;
  try {
    json = (await response.json()) as RawResponse;
  } catch {
    throw new TencentApiError('NetworkError', `腾讯云返回非 JSON（HTTP ${response.status}）`);
  }

  const body2 = json.Response ?? {};
  const apiError = body2.Error;
  if (apiError) {
    throw new TencentApiError(
      apiError.Code ?? 'UnknownError',
      apiError.Message ?? '腾讯云返回未知错误',
      apiError.RequestId ?? body2.RequestId ?? ''
    );
  }

  return body2 as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asString(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 把腾讯云返回的部门树展平成带路径的列表。
 *
 * 节点顺序不可靠（父节点可能在后），因此先建索引再算路径，不做递归回溯。
 */
export function flattenNodes(
  items: { NodeId?: unknown; Name?: unknown; ParentNodeId?: unknown }[]
): OrganizationNode[] {
  const byId = new Map<number, { nodeId: number; name: string; parentId: number }>();
  for (const item of items) {
    const nodeId = asNumber(item.NodeId);
    if (nodeId <= 0) continue;
    byId.set(nodeId, {
      nodeId,
      name: asString(item.Name),
      parentId: asNumber(item.ParentNodeId),
    });
  }

  const pathOf = (nodeId: number, seen = new Set<number>()): string => {
    const node = byId.get(nodeId);
    if (!node || seen.has(nodeId)) return '';
    seen.add(nodeId);
    const parentPath = node.parentId > 0 ? pathOf(node.parentId, seen) : '';
    return parentPath ? `${parentPath} / ${node.name}` : node.name;
  };

  return [...byId.values()].map((node) => ({ ...node, path: pathOf(node.nodeId) }));
}

export function createOrganizationClient(
  config: OrganizationClientConfig,
  deps: Deps = {}
): OrganizationClient {
  return {
    kind: 'tencent',

    async describeNodes(options = {}) {
      const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
      const nowMs = deps.now ?? (() => Date.now());
      const collected: { NodeId?: unknown; Name?: unknown; ParentNodeId?: unknown }[] = [];
      let offset = 0;
      let total = 0;

      for (let page = 0; page < maxPages; page += 1) {
        let timeoutOverride: number | undefined;
        if (options.deadline !== undefined) {
          const remaining = options.deadline - nowMs();
          if (remaining <= 0) {
            throw new TencentApiError('Timeout', '部门处理超时，请稍后重试');
          }
          timeoutOverride = remaining;
        }

        const data = await callOrganization(
          config,
          deps,
          'DescribeOrganizationNodes',
          { Limit: NODE_PAGE_SIZE, Offset: offset },
          timeoutOverride
        );
        const items = Array.isArray(data.Items)
          ? (data.Items as { NodeId?: unknown; Name?: unknown; ParentNodeId?: unknown }[])
          : [];
        collected.push(...items);

        total = asNumber(data.Total);
        offset += NODE_PAGE_SIZE;
        if (items.length === 0) break;
        if (collected.length >= total) {
          return { nodes: flattenNodes(collected), truncated: false };
        }
      }

      // 走到这里说明被页数上限截断，或服务端返回空页但 Total 更大
      return { nodes: flattenNodes(collected), truncated: collected.length < total };
    },

    async addNode(input) {
      const data = await callOrganization(config, deps, 'AddOrganizationNode', {
        ParentNodeId: input.parentNodeId,
        Name: input.name,
        ...(input.remark === undefined ? {} : { Remark: input.remark }),
      });
      return { nodeId: asNumber(data.NodeId), requestId: asString(data.RequestId) };
    },

    async createMember(input) {
      const data = await callOrganization(config, deps, 'CreateOrganizationMember', {
        Name: input.name,
        AccountName: input.accountName,
        NodeId: input.nodeId,
        PolicyType: input.policyType,
        PermissionIds: input.permissionIds,
        Remark: input.remark,
      });
      return { uin: asString(data.Uin), requestId: asString(data.RequestId) };
    },

    async deleteMember(uin) {
      try {
        // DeleteAccount 的 MemberUin 是**单值** Integer，不要传数组。
        // 单独放宽超时：销号要清理成员名下资源，实测比建号慢，用默认 5s 会被掐断——
        // 更糟的是云侧其实已经删成功，只是响应回来晚了，上层会误判成失败并回滚。
        const data = await callOrganization(
          config,
          deps,
          'DeleteAccount',
          { MemberUin: Number(uin) },
          DELETE_TIMEOUT_MS
        );
        return {
          requestId: asString(data.RequestId),
          alreadyGone: false,
          pendingReview: false,
        };
      } catch (error) {
        if (!(error instanceof TencentApiError)) throw error;

        // 成员已不存在等价于删除成功
        if (/ResourceNotFound|MemberNotExist/i.test(error.code)) {
          return { requestId: error.requestId, alreadyGone: true, pendingReview: false };
        }
        // 已进入注销审核：销号申请受理成功，但账号还在（最长约 3 个工作日）
        if (/MemberAccountDeregisterPending/i.test(error.code)) {
          return { requestId: error.requestId, alreadyGone: false, pendingReview: true };
        }
        throw error;
      }
    },

    async bindEmail(input) {
      const data = await callOrganization(config, deps, 'AddOrganizationMemberEmail', {
        MemberUin: Number(input.uin),
        Email: input.email,
        CountryCode: input.countryCode,
        Phone: input.phone,
      });
      return { bindId: asString(data.BindId), requestId: asString(data.RequestId) };
    },

    async getEmailBindStatus(uin) {
      const data = await callOrganization(config, deps, 'DescribeOrganizationMemberEmailBind', {
        MemberUin: Number(uin),
      });
      return { bindStatus: asString(data.BindStatus), requestId: asString(data.RequestId) };
    },

    async findMemberByName(name) {
      const data = await callOrganization(config, deps, 'DescribeOrganizationMembers', {
        SearchKey: name,
        Offset: 0,
        Limit: 50,
      });
      const items = Array.isArray(data.Items)
        ? (data.Items as { MemberUin?: unknown; Name?: unknown; Remark?: unknown }[])
        : [];
      const hit = items.find((item) => asString(item.Name).trim() === name);
      if (!hit) return null;
      return {
        uin: asString(hit.MemberUin),
        name: asString(hit.Name),
        remark: asString(hit.Remark),
      };
    },
  };
}
