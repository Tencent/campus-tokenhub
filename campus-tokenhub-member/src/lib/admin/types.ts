/** 管理员名单的可选身份：`school_id:user_id` + 展示名 + 邮箱 */
export type AdminCandidate = {
  /** `school_id:user_id` */
  sub: string;
  /** 展示名：开户邮箱里的姓名 → 退化为 sub */
  name: string;
  /** 网关邮箱，作为副标题；没有则为 null */
  email: string | null;
  /** 是否已在名单里（弹窗里置灰并标注） */
  listed: boolean;
};
