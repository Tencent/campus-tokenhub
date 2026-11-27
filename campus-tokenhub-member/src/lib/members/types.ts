/**
 * 成员账号申请单的领域类型。
 *
 * 一张申请单对应一位老师的一枚腾讯云集团成员账号；`applicantSub` 是 SSO 身份
 * （`school_id:user_id`），一名申请人在同一时间只能有一张单。
 */

export type MemberStatus =
  | 'pending'
  | 'provisioning'
  | 'active'
  /** 已发起删除、正在等云侧结果；与 provisioning 同理，先落状态再调云 */
  | 'removing'
  /** 云侧已移除，记录保留以便追溯；本人可重新申请 */
  | 'deleted'
  | 'needs_email'
  | 'needs_phone'
  | 'failed'
  | 'rejected';

/** 状态变更轨迹。只保留最近若干条，避免单条记录随时间无限膨胀。 */
export type MemberEvent = {
  at: string;
  from: MemberStatus | null;
  to: MemberStatus;
  actor: 'user' | 'admin' | 'system';
  note?: string;
};

export type MemberApplication = {
  id: string;
  /** SSO 身份：`school_id:user_id` */
  applicantSub: string;
  applicantName: string;
  /** 从 sub 解析出的数字 user_id，用于生成成员名 */
  userId: number;
  /** 腾讯云成员名（同时作为 AccountName），≤25 字符且全局唯一 */
  memberName: string;
  email: string;
  countryCode: string;
  phone: string;
  /** 申请人填写的多级部门路径（规范形式：`教务处/数学组`，不含 root） */
  departmentPath: string;
  /** 审核通过时实际落到的腾讯云节点 ID；未开通成功前为 null */
  resolvedNodeId: number | null;
  /** 审核通过时实际落到的节点路径（根节点之后）；用于审计与排障 */
  resolvedNodePath: string | null;
  remark: string;
  status: MemberStatus;
  /** 腾讯云成员 Uin；建号成功后才有值 */
  uin: string | null;
  errorCode: string | null;
  /** 面向老师的中文提示，不含错误码与 RequestId */
  errorMessage: string | null;
  /** 腾讯云 RequestId，只给管理员排障 */
  tencentRequestId: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** 进入 provisioning 的时间，用于区分「正在开通」与「已中断」 */
  provisioningStartedAt: string | null;
  /** 进入 removing 的时间，用于识别中断的删除操作 */
  removingStartedAt: string | null;
  /** 云侧移除成功的时间 */
  deletedAt: string | null;
  /** DeleteOrganizationMembers 的 RequestId，供管理员排障 */
  deleteRequestId: string | null;
  /** 最近一次删除失败的原因（云侧原文），失败回滚后留痕 */
  deleteError: string | null;
  /** 上一次开通尝试结束时间，用于提交冷却 */
  lastAttemptAt: string | null;
  /**
   * 本人修改资料后重新提交的次数（首次提交为 0）。
   * 管理员据此在审核列表里区分「首次提交」与「修改后重新提交」。
   */
  revision: number;
  events: MemberEvent[];
  createdAt: string;
  updatedAt: string;
};

/** 存储层错误：读不出、写不进、文件损坏都归到这里，页面统一降级提示。 */
export class MemberStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberStoreError';
  }
}

/** 腾讯云侧返回的部门节点（扁平化后带路径，便于下拉展示）。 */
export type OrganizationNode = {
  nodeId: number;
  name: string;
  parentId: number;
  /** 形如「总部 / 教务处」 */
  path: string;
};

/**
 * 管理员名单的可选项（`/members/admins` 的搜索/选择结果）。
 *
 * 定义在纯类型文件里：客户端组件要用它，不能把服务端的 `admin-store` 拉进浏览器包。
 */
export type MemberAdminCandidate = {
  /** `school_id:user_id` */
  sub: string;
  /** 展示名：成员申请里的姓名 → 开户邮箱里的姓名 → 退化为 sub */
  name: string;
  /** 网关邮箱，作为副标题；没有则为 null */
  email: string | null;
  /** 是否已在管理员名单 */
  listed: boolean;
};
