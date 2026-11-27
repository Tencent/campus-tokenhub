/**
 * member 侧隔离门禁规则。
 *
 * 目标：member 站（成员自购）不得出现任何网关 / 算力侧依赖。
 *
 * 受控例外：管理员候选页从共享库只读 `octafuse_gateway.users` 补姓名，封装在
 * `src/lib/admin/candidates.ts`，不引网关客户端、不写网关数据；单站部署无此
 * schema 时自动降级。本门禁只拦「代码层依赖」，不拦这一处显式 SQL 只读查询。
 *
 * ⚠️ 故意不禁裸词 `octafuse`：
 * 会话 claim 名 `octafuse_user_id` 是**跨站互认的必需字段**（读取端必须解析它，
 * 见 design D6），把它一并禁掉会让门禁永远红。这里改为精确禁「写入端字段」
 * （`octafuseUserId`）与「网关守卫」（`requireOctofuseUserId`），既能拦住回潮，
 * 又不误伤互认所需的那一处。
 */

/** 只扫这些扩展名，md / json 里的字样不算违规 */
export const SOURCE_EXT = ['.ts', '.tsx'];

export const RULES = [
  { name: 'gateway', test: /@\/lib\/gateway/ },
  { name: 'onboarding', test: /@\/lib\/onboarding/ },
  { name: 'playground', test: /@\/lib\/playground/ },
  { name: 'activities', test: /@\/lib\/activities/ },
  { name: 'guide', test: /@\/lib\/guide/ },
  { name: 'octafuse-env', test: /\bOCTAFUSE_[A-Z_]+\b/ },
  { name: 'proxy-base', test: /\bgetPublicProxyBase\b/ },
  { name: 'octafuse-user-id-write', test: /\boctafuseUserId\b/ },
  { name: 'octafuse-user-id-guard', test: /\brequireOctofuseUserId\b/ },
  { name: 'provision-user', test: /\bprovisionUser\b/ },
  { name: 'gateway-schema', test: /\bportal_gateway\b/ },
];
