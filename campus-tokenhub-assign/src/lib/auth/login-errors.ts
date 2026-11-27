/**
 * 登录页错误码 → 中文文案。
 *
 * 用 Map 而非普通对象：`?error=__proto__` 之类原型链 key 不能被当成文案渲染。
 * 未知错误码一律回落到通用文案，不回显原始 query，避免构造站内钓鱼话术。
 */

const ERROR_TEXT = new Map<string, string>([
  ['callback_unavailable', '登录回调暂不可用，请从登录页重新发起。'],
  ['tx_missing', '登录已超时，请重新登录。'],
  ['state_mismatch', '登录状态校验失败，请重新登录。'],
  ['code_missing', '登录回调缺少授权码，请重新登录。'],
  ['token_exchange_failed', '与学校认证服务通信失败，请稍后重试。'],
  ['user_info_failed', '获取师生信息失败，请稍后重试。'],
  ['login_restricted', '当前账号不在允许登录的范围内，请联系管理员开通。'],
  ['restrict_misconfigured', '登录限制配置不完整，请联系管理员。'],
  ['identity_invalid', '身份信息缺少用户标识，请联系管理员。'],
  ['ticket_missing', '统一认证回调缺少票据，请重新登录。'],
  ['ticket_invalid', '统一认证票据校验失败，请重新登录。'],
  ['token_missing', '统一认证回调缺少登录凭证，请重新登录。'],
  ['login_start_failed', '发起登录失败，请稍后重试。'],
  ['auth_unsafe', '登录认证配置无效，请在设置页修正 SSO 协议与参数。'],
  // 引导期账号密码登录：关闭后统一提示改用学校认证，不透露账号是否存在
  ['password_invalid', '账号或密码不正确，请重试。'],
  ['password_disabled', '账号密码登录已关闭，请使用学校统一认证登录。'],
  ['password_rate_limited', '尝试过于频繁，请 15 分钟后再试。'],
  ['password_unconfigured', '尚未配置登录方式，请联系部署人员。'],
  ['origin_mismatch', '请求来源校验失败，请从登录页重新提交。'],
  ['id_token_invalid', '身份信息校验失败，请联系管理员。'],
  ['nonce_mismatch', '登录状态校验失败，请重新登录。'],
  ['endpoint_blocked', '登录端点地址不被允许：它指向了本机或云元数据地址，请管理员在设置页修正。'],
  ['access_denied', '你取消了登录，或学校账号没有访问权限。'],
  ['login_failed', '登录失败，请重试。'],
  // 企业微信自建应用：上游 errcode / errmsg 只进服务端日志，不回显到登录页
  ['wecom_not_member', '非本企业成员，无法登录，请联系管理员。'],
  ['wecom_token_failed', '企业微信认证服务通信失败，请稍后重试。'],
  ['wecom_userinfo_failed', '获取企业微信成员信息失败，请稍后重试。'],
  ['wecom_config_missing', '企业微信登录尚未配置完成，请联系管理员。'],
  [
    'wecom_qr_unavailable',
    '扫码登录暂不可用（访问域名与 PUBLIC_BASE_URL 不一致或组件加载失败），请使用企业微信网页授权。',
  ],
]);

const GENERIC = '登录失败，请重试。';

/** 过滤控制字符，避免把不可见字符或终端转义序列塞进页面。 */
function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * Mock 登录会把中文失败原因放在 query 里，需要保留可读性；
 * 但含邮箱 / URL / 过长内容的文本不予回显，防止被人拿去造钓鱼提示。
 */
function isSafeChineseReason(value: string): boolean {
  if (!/[\u4e00-\u9fa5]/.test(value)) return false;
  if (value.length > 40) return false;
  if (/@|https?:\/\/|\/\//.test(value)) return false;
  return true;
}

export function readableError(code: string | undefined | null): string | null {
  if (!code) return null;

  const known = ERROR_TEXT.get(code);
  if (known) return known;

  const cleaned = stripControlChars(code);
  return isSafeChineseReason(cleaned) ? cleaned : GENERIC;
}
