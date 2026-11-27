/**
 * 本地 / 回归用的假组织客户端。
 *
 * 存在的意义是让「提交 → 审核 → 建部门 → 建号」这条链路可复现地跑通：没有它，
 * 验收步骤要么真去腾讯云建号，要么手工改代码注入假客户端，两种都不是可交付的流程。
 *
 * 行为尽量贴近真实接口的失败语义（邮箱已被他人占用、成员已绑过邮箱、成员重名、同级部门重名），
 * 这样本地能覆盖到的分支和线上一致。
 *
 * 节点树**每个实例一份**：模块级可变数组会让不同测试用例互相污染。
 */

import type { OrganizationNode } from '@/lib/members/types';
import {
  TencentApiError,
  type AddNodeInput,
  type BindEmailInput,
  type CreateMemberInput,
  type OrganizationClient,
} from './organization';

type NodeRow = { nodeId: number; name: string; parentId: number };

function seedNodes(): NodeRow[] {
  return [
    { nodeId: 1, name: '总部', parentId: 0 },
    { nodeId: 2, name: '教务处', parentId: 1 },
    { nodeId: 3, name: '数学组', parentId: 2 },
  ];
}

function pathOf(nodes: NodeRow[], nodeId: number, seen = new Set<number>()): string {
  const row = nodes.find((item) => item.nodeId === nodeId);
  if (!row || seen.has(nodeId)) return '';
  seen.add(nodeId);
  const parentPath = row.parentId > 0 ? pathOf(nodes, row.parentId, seen) : '';
  return parentPath ? `${parentPath} / ${row.name}` : row.name;
}

type MockMember = {
  uin: string;
  name: string;
  remark: string;
  email: string | null;
};

export function createMockOrganizationClient(): OrganizationClient {
  // 每个实例独立的可变状态
  const nodes: NodeRow[] = seedNodes();
  const members = new Map<string, MockMember>();
  let seq = 100000000001;
  let nodeSeq = 100;

  return {
    kind: 'mock',

    async describeNodes() {
      const result = nodes.map<OrganizationNode>((row) => ({
        nodeId: row.nodeId,
        name: row.name,
        parentId: row.parentId,
        path: pathOf(nodes, row.nodeId),
      }));
      return { nodes: result, truncated: false };
    },

    async addNode(input: AddNodeInput) {
      const parent = nodes.find((item) => item.nodeId === input.parentNodeId);
      if (!parent) {
        throw new TencentApiError('InvalidParameter.OrganizationNodeNotExist', '父节点不存在');
      }
      const duplicated = nodes.some(
        (item) => item.parentId === input.parentNodeId && item.name === input.name
      );
      if (duplicated) {
        throw new TencentApiError(
          'FailedOperation.OrganizationNodeNameUsed',
          '同级已存在同名部门',
          'mock-req'
        );
      }

      const created: NodeRow = {
        nodeId: nodeSeq++,
        name: input.name,
        parentId: input.parentNodeId,
      };
      nodes.push(created);
      return { nodeId: created.nodeId, requestId: 'mock-req' };
    },

    async createMember(input: CreateMemberInput) {
      if (!nodes.some((item) => item.nodeId === input.nodeId)) {
        throw new TencentApiError('InvalidParameter.OrganizationNodeNotExist', '部门不存在');
      }
      const existing = members.get(input.name);
      if (existing) {
        throw new TencentApiError(
          'FailedOperation.OrganizationMemberNameUsed',
          '成员名已存在',
          'mock-req'
        );
      }
      const uin = String(seq++);
      members.set(input.name, { uin, name: input.name, remark: input.remark, email: null });
      return { uin, requestId: 'mock-req' };
    },

    async deleteMember(uin: string) {
      const entry = [...members.entries()].find(([, item]) => item.uin === uin);
      if (!entry) return { requestId: 'mock-req', alreadyGone: true, pendingReview: false };
      members.delete(entry[0]);
      return { requestId: 'mock-req', alreadyGone: false, pendingReview: false };
    },

    async bindEmail(input: BindEmailInput) {
      const member = [...members.values()].find((item) => item.uin === input.uin);
      if (!member) {
        throw new TencentApiError('InvalidParameter.OrganizationMemberNotExist', '成员不存在');
      }
      if (member.email && member.email !== input.email) {
        throw new TencentApiError('FailedOperation.MemberEmailExist', '该成员已绑定过邮箱');
      }
      const usedByOther = [...members.values()].some(
        (item) => item.uin !== input.uin && item.email === input.email
      );
      if (usedByOther) {
        throw new TencentApiError('FailedOperation.EmailAlreadyUsed', '邮箱已被占用');
      }
      member.email = input.email;
      return { bindId: `bind-${input.uin}`, requestId: 'mock-req' };
    },

    async getEmailBindStatus(uin) {
      const member = [...members.values()].find((item) => item.uin === uin);
      return { bindStatus: member?.email ? 'Success' : 'Unbound', requestId: 'mock-req' };
    },

    async findMemberByName(name) {
      const member = members.get(name);
      if (!member) return null;
      return { uin: member.uin, name: member.name, remark: member.remark };
    },
  };
}
