/**
 * assign 侧隔离门禁规则。
 *
 * 目标：assign 站（学校统一采买）不得出现任何成员自购 / 腾讯云组织侧依赖。
 *
 * 与 member 侧相反，这里 `octafuse` 字样是正常的（网关就是 assign 的地盘），
 * 因此不做任何 octafuse 相关限制。
 */

/** 只扫这些扩展名，md / json 里的字样不算违规 */
export const SOURCE_EXT = ['.ts', '.tsx'];

export const RULES = [
  { name: 'members', test: /@\/lib\/members/ },
  { name: 'tencent', test: /@\/lib\/tencent/ },
  { name: 'tencentcloud-env', test: /\bTENCENTCLOUD_[A-Z_]+\b/ },
  { name: 'member-account-env', test: /\bMEMBER_ACCOUNT_[A-Z_]+\b/ },
  { name: 'member-applications', test: /\bmember_applications\b/ },
  { name: 'member-routes', test: /\/api\/portal\/members/ },
];
