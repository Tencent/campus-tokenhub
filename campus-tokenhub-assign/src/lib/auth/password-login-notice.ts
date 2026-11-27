/**
 * 密码登录的风险提示文案。
 *
 * 单独成模块的唯一理由：登录页（服务端组件）与设置页（**客户端组件**）都要用同一句话。
 * 客户端组件只能依赖不含 node 内置模块的纯模块——直接 import `local-admin.ts`
 * 会把 `node:crypto` / `pg` 一起带进浏览器与 edge 编译（Next build 会直接失败）。
 */
export const PASSWORD_LOGIN_RISK_NOTICE =
  '账号密码登录会绕过学校统一认证的 MFA 与离校回收：确认学校账号能登录后，请把「账号密码登录」改为 off';
