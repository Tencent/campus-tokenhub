/**
 * 服务端部门解析：按 `教务处/数学组` 从组织根节点逐级查找，缺哪级建哪级。
 *
 * 三条铁律：
 * 1. **只在服务端使用**：本模块依赖 `organization` 客户端（其签名模块引入 `node:crypto`），
 *    禁止被 `'use client'` 组件引用；客户端只需要 `department-path.ts` 的纯校验。
 * 2. **先查后建 + 重名回查**：先按名称精确匹配，未命中才 `AddOrganizationNode`；
 *    重名错误回查一次再匹配，避免并发下建出重复节点，也不覆盖已有节点。
 * 3. **有界**：分页最多 4 页（200 节点）、总预算 20 秒，超界直接失败可重试，
 *    不允许把审核请求拖进 `PROVISION_TIMEOUT_MS`（120 秒）的重试窗口。
 */

import type { OrganizationNode } from '@/lib/members/types';
import { TencentApiError, type OrganizationClient } from '@/lib/tencent/organization';

/** 部门阶段总预算 */
export const DEPARTMENT_BUDGET_MS = 20_000;
/** 节点树最多拉取页数（每页 50） */
export const DEPARTMENT_MAX_PAGES = 4;
const PAGE_SIZE = 50;
/** 节点树上限：超过即视为规模过大，不继续自动建部门 */
export const DEPARTMENT_MAX_NODES = DEPARTMENT_MAX_PAGES * PAGE_SIZE;
/** 新建节点的归属标记，误建时可据此识别 */
export const DEPARTMENT_NODE_REMARK = 'portal:auto';

const NODE_NAME_USED = 'FailedOperation.OrganizationNodeNameUsed';

/** 解析失败：`code` 直接落申请单的 `errorCode`，`message` 为面向管理员的中文提示 */
export class DepartmentError extends Error {
  readonly code: string;
  readonly requestId: string;

  constructor(code: string, message: string, requestId = '') {
    super(message);
    this.name = 'DepartmentError';
    this.code = code;
    this.requestId = requestId;
  }
}

export type ResolveDepartmentInput = {
  /** 已归一化的路径分段（不含 root） */
  segments: string[];
  client: OrganizationClient;
  /** 配置的根节点；0 / 缺省表示自动推断 */
  rootNodeId?: number;
  budgetMs?: number;
  /** 测试注入时钟 */
  now?: () => number;
};

export type ResolveDepartmentResult = {
  nodeId: number;
  /** 根节点之后的规范路径 */
  path: string;
  /** 本次新建的层级（按创建顺序） */
  created: string[];
  rootNodeId: number;
  /** 树中存在多个根节点时为 true（取 nodeId 最小者），调用方据此写审计 */
  multipleRoots: boolean;
};

function indexByParent(nodes: OrganizationNode[]): Map<number, OrganizationNode[]> {
  const byParent = new Map<number, OrganizationNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  return byParent;
}

function findChild(
  byParent: Map<number, OrganizationNode[]>,
  parentId: number,
  name: string
): OrganizationNode | undefined {
  const target = name.trim();
  return (byParent.get(parentId) ?? []).find((node) => node.name.trim() === target);
}

function isNodeNameUsed(error: unknown): boolean {
  return error instanceof TencentApiError && error.code === NODE_NAME_USED;
}

function toDepartmentError(error: unknown): DepartmentError {
  if (error instanceof DepartmentError) return error;
  if (error instanceof TencentApiError) {
    return new DepartmentError(error.code, error.message, error.requestId);
  }
  return new DepartmentError(
    'department_failed',
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * 解析部门路径为末级节点 ID。
 *
 * @throws DepartmentError `department_root_missing` / `department_empty` /
 *   `department_conflict` / `department_tree_too_large` / `department_timeout`，
 *   或腾讯云原始错误码（如 `UnauthorizedOperation`）。
 */
export async function resolveDepartment(
  input: ResolveDepartmentInput
): Promise<ResolveDepartmentResult> {
  const { client, segments } = input;
  const budgetMs = input.budgetMs ?? DEPARTMENT_BUDGET_MS;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  const guard = (): void => {
    if (now() - startedAt >= budgetMs) {
      throw new DepartmentError('department_timeout', '部门处理超时，请稍后重试');
    }
  };

  // 纯本地可判定的输入先拒绝，避免为非法输入白打一次腾讯云
  let levels = segments.map((segment) => segment.trim());
  if (levels.length === 0) {
    throw new DepartmentError('department_empty', '请至少填写一级部门');
  }
  if (levels.some((level) => level.length === 0)) {
    throw new DepartmentError('department_failed', '部门路径包含空层级，请重新填写');
  }

  guard();

  let nodes: OrganizationNode[];
  try {
    const fetched = await client.describeNodes({
      maxPages: DEPARTMENT_MAX_PAGES,
      deadline: startedAt + budgetMs,
    });
    nodes = fetched.nodes;
    if (fetched.truncated) {
      throw new DepartmentError(
        'department_tree_too_large',
        '组织节点过多，暂时无法自动创建部门，请联系管理员'
      );
    }
  } catch (error) {
    throw toDepartmentError(error);
  }

  if (nodes.length > DEPARTMENT_MAX_NODES) {
    throw new DepartmentError(
      'department_tree_too_large',
      '组织节点过多，暂时无法自动创建部门，请联系管理员'
    );
  }

  // ---------------------------------------------------------------- 根节点
  const configuredRootId = input.rootNodeId ?? 0;
  let root: OrganizationNode | undefined;
  let multipleRoots = false;

  if (configuredRootId > 0) {
    root = nodes.find((node) => node.nodeId === configuredRootId);
    if (!root) {
      throw new DepartmentError(
        'department_root_missing',
        '无法识别腾讯云组织根节点，请联系管理员核对凭据'
      );
    }
  } else {
    const roots = nodes
      .filter((node) => node.parentId === 0)
      .sort((left, right) => left.nodeId - right.nodeId);
    if (roots.length === 0) {
      throw new DepartmentError(
        'department_root_missing',
        '无法识别腾讯云组织根节点，请联系管理员核对凭据'
      );
    }
    root = roots[0];
    multipleRoots = roots.length > 1;
  }

  // 用户不需要填写 root；首段与根节点同名（忽略大小写）时直接忽略
  const rootName = root.name.trim().toLowerCase();
  if (levels.length > 0 && levels[0].toLowerCase() === rootName) {
    levels = levels.slice(1);
  }
  if (levels.length === 0) {
    throw new DepartmentError('department_empty', '请至少填写一级部门');
  }

  // ---------------------------------------------------------------- 逐级下探
  let byParent = indexByParent(nodes);
  let current = root;
  const created: string[] = [];

  for (const name of levels) {
    guard();

    const hit = findChild(byParent, current.nodeId, name);
    if (hit) {
      current = hit;
      continue;
    }

    try {
      const added = await client.addNode({
        parentNodeId: current.nodeId,
        name,
        remark: DEPARTMENT_NODE_REMARK,
      });
      guard();

      if (!Number.isInteger(added.nodeId) || added.nodeId <= 0) {
        throw new DepartmentError('department_failed', '创建部门未返回有效节点 ID，请稍后重试');
      }

      const newNode: OrganizationNode = {
        nodeId: added.nodeId,
        name,
        parentId: current.nodeId,
        path: '',
      };
      const siblings = byParent.get(current.nodeId) ?? [];
      siblings.push(newNode);
      byParent.set(current.nodeId, siblings);

      created.push(name);
      current = newNode;
    } catch (error) {
      if (!isNodeNameUsed(error)) throw toDepartmentError(error);

      // 并发或缓存不同步：重新拉一次再匹配，仍不命中才算冲突
      try {
        const refreshed = await client.describeNodes({
          maxPages: DEPARTMENT_MAX_PAGES,
          deadline: startedAt + budgetMs,
        });
        if (refreshed.truncated) {
          throw new DepartmentError(
            'department_tree_too_large',
            '组织节点过多，暂时无法自动创建部门，请联系管理员'
          );
        }
        nodes = refreshed.nodes;
      } catch (refreshError) {
        throw toDepartmentError(refreshError);
      }
      byParent = indexByParent(nodes);

      const retried = findChild(byParent, current.nodeId, name);
      if (!retried) {
        throw new DepartmentError(
          'department_conflict',
          '部门名与腾讯云已有部门冲突，请管理员到腾讯云控制台查看同名节点后驳回',
          error instanceof TencentApiError ? error.requestId : ''
        );
      }
      current = retried;
    }
  }

  return {
    nodeId: current.nodeId,
    path: levels.join('/'),
    created,
    rootNodeId: root.nodeId,
    multipleRoots,
  };
}
