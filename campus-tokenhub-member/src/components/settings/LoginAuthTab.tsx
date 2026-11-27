'use client';

/**
 * 设置页「登录认证」分组。
 *
 * 顺序：部署管理员（账号密码登录）→ SSO 协议 → 协议参数 → 登录限制。
 * 部署管理员放最前：先有能登进来的入口，才谈得上配 SSO。
 * 先选 SSO 协议，只显示当前协议需要的标准协议参数；
 * OAuth2 额外支持「字段映射」：把 userinfo 里任意字段（支持 `data.user_id` 级联）
 * 映射到门户身份，不写死厂商 claim 名；
 * 最后是通用「登录限制」：开关 + 条件列表，条件之间是「且」，两种协议共用。
 * 密钥输入框留空表示不修改；保存由外壳统一提交。
 */

import {
  FIELDS,
  RESTRICT_FIELD_NAMES,
  type LoginField,
  type RestrictCondition,
  type RestrictFieldName,
} from '@/lib/config/fields';
import type { SettingsPayload } from '@/lib/config/settings-view';
import type { PasswordLoginState } from '@/lib/auth/local-admin';
import { FieldRow, NumberInput, SecretInput, SelectInput, TextInput, Toggle, FIELD_INPUT_CLASS } from './fields';

const PROVIDER_LABELS: Record<string, string> = {
  oauth2: 'OAuth2（标准授权码）',
  cas: 'CAS（标准服务票据）',
  wecom: '企业微信（自建应用）',
};

/** 端点参数：三个 URL + 端点认证方式 / token 携带方式，都是「怎么和 IdP 通信」 */
const OAUTH2_ENDPOINT_FIELDS: readonly LoginField[] = [
  'oauth2AuthorizationEndpoint',
  'oauth2TokenEndpoint',
  'oauth2UserInfoEndpoint',
  'oauth2TokenAuthMethod',
  'oauth2UserInfoTokenCarrier',
];

/** 客户端凭据与授权范围 */
const OAUTH2_CLIENT_FIELDS: readonly LoginField[] = [
  'oauth2ClientId',
  'oauth2ClientSecret',
  'oauth2Scopes',
];

const FIELD_MAP_FIELDS: readonly LoginField[] = [
  'oauth2FieldMapSubject',
  'oauth2FieldMapEmail',
  'oauth2FieldMapName',
  'oauth2FieldMapSchoolCode',
  'oauth2FieldMapSchoolName',
  'oauth2FieldMapRoles',
];

const CAS_FIELDS: readonly LoginField[] = ['casLoginUrl', 'casTicketValidateUrl'];

/** 企业微信自建应用：三项必填 + 授权范围；Secret 走 SecretInput，留空不修改 */
const WECOM_FIELDS: readonly LoginField[] = [
  'wecomCorpId',
  'wecomAgentId',
  'wecomClientSecret',
  'wecomScope',
];

const ENUM_LABELS: Partial<Record<LoginField, Record<string, string>>> = {
  oauth2TokenAuthMethod: {
    client_secret_basic: 'HTTP Basic（请求头）',
    client_secret_post: '表单参数（请求体）',
  },
  oauth2UserInfoTokenCarrier: {
    header: 'Authorization 请求头（Bearer）',
    query: 'URL 查询参数（access_token）',
  },
  wecomScope: {
    snsapi_base: 'snsapi_base（静默授权，推荐）',
    snsapi_privateinfo: 'snsapi_privateinfo（成员须在应用可见范围）',
  },
};

const RESTRICT_FIELD_LABELS: Record<RestrictFieldName, string> = {
  subject: '外部用户 ID',
  email: '邮箱',
  name: '姓名',
  schoolCode: '学校编码（机构 ID）',
  schoolName: '学校名称',
  roles: '角色',
  custom: '自定义字段路径',
};

/** 草稿里的条件列表以 JSON 文本保存：解析失败按空列表处理，由服务端校验兜底 */
function parseConditions(raw: string | undefined): RestrictCondition[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => {
        const field = String(item.field ?? 'subject');
        return {
          field: (RESTRICT_FIELD_NAMES.includes(field as RestrictFieldName)
            ? field
            : 'subject') as RestrictFieldName,
          path: typeof item.path === 'string' ? item.path : '',
          value: typeof item.value === 'string' ? item.value : '',
        };
      });
  } catch {
    return [];
  }
}

/** 服务端算好的登录方式状态：env 凭据 + DB 里的 SSO 参数一起决定，客户端拿不到全貌 */
export type LoginAuthState = {
  password: PasswordLoginState;
  ssoConfigured: boolean;
};

export type LoginAuthTabProps = {
  draft: Partial<Record<LoginField, string>>;
  secretDraft: Partial<Record<LoginField, string>>;
  fieldErrors: Partial<Record<LoginField, string>>;
  secrets: SettingsPayload['secrets'];
  loginState: LoginAuthState;
  /** 服务端按 PUBLIC_BASE_URL + 固定回调路径算好；PUBLIC_BASE_URL 为空时是路径 */
  callbackUrl: string;
  onChange: (field: LoginField, value: string) => void;
  onSecretChange: (field: LoginField, value: string) => void;
  onBlur: (field: LoginField) => void;
  onClearSecret: (field: LoginField) => void;
};

/** 当前生效的登录方式说明：解释「登录页为什么长这样」，避免运维误判 */
function LoginModeNotice({ state }: { state: LoginAuthState }) {
  const text =
    state.password === 'available'
      ? state.ssoConfigured
        ? 'SSO 已配置 · 账号密码登录仍可用（救急通道；确认 SSO 调通后可改为 off 关闭）'
        : 'SSO 未配置完成 · 账号密码登录可用（仅用于继续配置）'
      : state.password === 'disabled_by_switch'
        ? '账号密码登录已由「账号密码登录 = off」关闭'
        : state.ssoConfigured
          ? 'SSO 已配置 · 未设置引导账号'
          : 'SSO 未配置，且未设置 PORTAL_ADMIN_USERNAME / PORTAL_ADMIN_PASSWORD：当前无人能登录';

  // 只有两种「需要注意」的状态用琥珀色：引导入口还开着，或者根本没人能登录
  const warn =
    state.password === 'available' ||
    (state.password === 'unconfigured' && !state.ssoConfigured);

  return (
    <div
      className={`rounded-card border px-4 py-3 text-[13px] leading-relaxed ${
        warn
          ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-line bg-white text-ink-700'
      }`}
    >
      <span className="font-medium">登录方式</span>
      <span className="mx-1.5 text-ink-300">|</span>
      {text}
    </div>
  );
}

export function LoginAuthTab({
  draft,
  secretDraft,
  fieldErrors,
  secrets,
  loginState,
  callbackUrl,
  onChange,
  onSecretChange,
  onBlur,
  onClearSecret,
}: LoginAuthTabProps) {
  const provider = draft.provider || 'oauth2';
  const providerOptions = (FIELDS.provider.enumValues ?? ['oauth2', 'cas']).map(
    (value) => ({ value, label: PROVIDER_LABELS[value] ?? value })
  );
  const restrictEnabled = (draft.restrictEnabled ?? 'false') !== 'false';
  const conditions = parseConditions(draft.restrictConditions);
  const setConditions = (next: RestrictCondition[]) =>
    onChange('restrictConditions', JSON.stringify(next));

  const updateCondition = (index: number, patch: Partial<RestrictCondition>) => {
    setConditions(conditions.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  function renderField(field: LoginField) {
    const def = FIELDS[field];

    const control = def.secret ? (
      <SecretInput
        value={secretDraft[field] ?? ''}
        onChange={(next) => onSecretChange(field, next)}
        configured={secrets[field]?.configured ?? false}
        hint={secrets[field]?.hint ?? ''}
        onClear={() => onClearSecret(field)}
      />
    ) : def.type === 'boolean' ? (
      <Toggle
        label="启用"
        checked={(draft[field] ?? 'false') !== 'false'}
        onChange={(next) => onChange(field, String(next))}
      />
    ) : def.type === 'enum' ? (
      <SelectInput
        value={draft[field] ?? def.enumValues?.[0] ?? ''}
        onChange={(next) => onChange(field, next)}
        options={(def.enumValues ?? []).map((value) => ({
          value,
          label: ENUM_LABELS[field]?.[value] ?? value,
        }))}
      />
    ) : def.type === 'number' ? (
      <NumberInput
        value={draft[field] ?? ''}
        onChange={(next) => onChange(field, next)}
        min={def.min}
      />
    ) : (
      <TextInput
        value={draft[field] ?? ''}
        onChange={(next) => onChange(field, next)}
        onBlur={() => onBlur(field)}
        maxLength={def.maxLength}
        error={Boolean(fieldErrors[field])}
        placeholder={def.patternHint}
      />
    );

    return (
      <FieldRow key={field} label={def.label} hint={def.description} error={fieldErrors[field]}>
        {control}
      </FieldRow>
    );
  }

  const hint =
    provider === 'cas'
      ? '直接对接学校 CAS Server：认证 URL 负责跳转，Ticket 校验 URL 负责服务端验票。'
      : provider === 'wecom'
        ? '企业微信自建应用：企微客户端内用网页授权；PC 浏览器在登录页内嵌官方扫码组件。'
        : '标准 OAuth2 授权码流程：授权 → 回调 code → token 端点换 token → 用户信息端点读身份。';

  return (
    <div className="max-w-2xl space-y-5">
      <LoginModeNotice state={loginState} />

      {/* 部署管理员：引导期账号密码登录，放在最上面——先有能登进来的入口，才谈得上配 SSO。
          原来只能靠环境变量，改一次要重启容器；SSO 调通后把它改成 auto/off 即可收口。 */}
      <div className="space-y-4 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink-900">部署管理员（账号密码登录）</h3>
        <p className="text-xs leading-relaxed text-ink-500">
          用于第一次配置 SSO，以及统一认证临时不可用时救急。
          默认 <code>auto</code> 不会自动关闭：SSO 参数填齐不等于调得通（密钥错、回调未登记都会失败），
          确认学校账号能登录之后，再手动改成 <code>off</code> 关闭。
        </p>
        {renderField('localAdminMode')}
        {renderField('localAdminUsername')}
        {renderField('localAdminPassword')}
        {loginState.password === 'available' ? (
          <p className="text-xs text-ink-500">
            当前状态：<span className="font-medium text-ink-800">可用</span>
            {loginState.ssoConfigured ? '（SSO 已配齐，调试通过后可改为 off 关闭）' : ''}
          </p>
        ) : (
          <p className="text-xs text-ink-500">
            当前状态：<span className="font-medium text-ink-800">不可用</span>
            {loginState.password === 'disabled_by_switch'
              ? '（被设置为 off）'
              : '（还没填账号或密码）'}
          </p>
        )}
      </div>

      <div className="space-y-4 border-t border-line pt-4">
        <FieldRow label="SSO 协议" hint="先选协议，下面只显示该协议需要的参数">
          <SelectInput
            value={provider}
            onChange={(next) => onChange('provider', next)}
            options={providerOptions}
          />
        </FieldRow>
      </div>

      {provider === 'wecom' ? null : (
        <div className="space-y-4 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink-900">
            {provider === 'cas' ? 'CAS 参数' : 'OAuth2 端点'}
          </h3>
          <p className="text-xs leading-relaxed text-ink-500">{hint}</p>
          {(provider === 'cas' ? CAS_FIELDS : OAUTH2_ENDPOINT_FIELDS).map((field) => renderField(field))}
        </div>
      )}

      {provider === 'wecom' ? (
        <div className="space-y-4 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink-900">企业微信参数</h3>
          <p className="text-xs leading-relaxed text-ink-500">{hint}</p>
          <p className="text-xs leading-relaxed text-ink-500">
            AgentID 来自自建应用详情页，只能是数字（如 <code>1000002</code>）；Secret
            留空表示不修改，如需清除请使用清除操作。
          </p>
          {WECOM_FIELDS.map((field) => renderField(field))}

          <div className="rounded-control border border-line bg-cream px-4 py-3 text-xs leading-[22px] text-ink-700">
            <p className="font-semibold text-ink-900">回调地址（企微后台登记用）</p>
            <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-[12px] text-ink-900">
              {callbackUrl}
            </code>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5">
              <li>在企微「我的企业 → 企业信息」获取 CorpID，填到上方对应字段。</li>
              <li>
                在「应用管理 → 自建应用」获取 AgentID / Secret，并设置应用可见范围。
              </li>
              <li>
                「企业微信授权登录 / 网页授权及JS-SDK → 可信域名（授权回调域）」填门户域名：不含协议、含端口（如有），不支持泛域名，须与上方回调地址域名一致。
              </li>
              <li>按企微提示把域名校验文件放到网站根目录，确认校验通过。</li>
              <li>
                扫码登录还要求浏览器实际访问域名与 <code>PUBLIC_BASE_URL</code> 的 origin
                一致（反代 / 多域名部署需显式配置），否则扫码初始化会返回{' '}
                <code>wecom_qr_unavailable</code>，企微组件可能报 31033 / 31039。
              </li>
              <li>
                <code>snsapi_base</code> 静默授权下企业成员均可登录（无论是否在应用可见范围）；
                选择 <code>snsapi_privateinfo</code> 时，成员必须在应用可见范围内，否则授权会报无权限。
              </li>
              <li>
                企微身份只映射外部用户 ID / 姓名 / 邮箱，没有 <code>schoolCode</code>。
              </li>
            </ol>
          </div>
        </div>
      ) : null}

      {provider === 'oauth2' ? (
        <div className="space-y-4 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink-900">客户端凭据</h3>
          <p className="text-xs leading-relaxed text-ink-500">
            在学校 IdP 注册的应用参数。回调地址由门户按部署域名自动生成（路径固定为
            <code> /api/auth/callback</code>），不需要填写。
          </p>
          {OAUTH2_CLIENT_FIELDS.map((field) => renderField(field))}
        </div>
      ) : null}

      {provider === 'oauth2' ? (
        <div className="space-y-4 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-ink-900">字段映射</h3>
          <p className="text-xs leading-relaxed text-ink-500">
            填用户信息接口返回的字段路径，支持级联（如 <code>data.user_id</code>）；
            外部用户 ID 支持 <code>{'{school_id}:{user_id}'}</code> 模板。留空表示按内置兼容字段识别。
          </p>
          {FIELD_MAP_FIELDS.map((field) => renderField(field))}
        </div>
      ) : null}

      {/* 企微自建应用身份没有角色字段、且 snsapi_base 下企业成员均可登录；
          这两块通用配置在 wecom 下不显示（oauth2 / cas 保留）。 */}
      {provider === 'wecom' ? null : (
      <>
      <div className="space-y-4 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink-900">管理员角色同步</h3>
        <p className="text-xs leading-relaxed text-ink-500">
          登录用户的角色命中下列任一值（忽略大小写）时，自动加入管理员名单；
          只新增、不删除已配置的管理员，留空表示关闭。
          角色取值来自「角色」字段映射解析出的结果（未配置时按内置 role / roles / groups 等字段识别）。
        </p>
        {renderField('adminRoles')}
      </div>

      <div className="space-y-4 border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink-900">登录限制</h3>
        <p className="text-xs leading-relaxed text-ink-500">
          关闭时不限制任何账号；开启后按下面每一条条件校验，全部满足才允许登录（多条之间是「且」）。
        </p>
        {renderField('restrictEnabled')}
        {restrictEnabled ? (
          <div className="space-y-3">
            {conditions.length === 0 ? (
              <p className="text-xs text-ink-500">还没有条件：至少添加一条，否则无法保存。</p>
            ) : null}
            {conditions.map((condition, index) => (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2 rounded-control border border-line p-2"
              >
                <select
                  aria-label={`第 ${index + 1} 条条件的字段`}
                  value={condition.field}
                  onChange={(event) =>
                    updateCondition(index, { field: event.target.value as RestrictFieldName })
                  }
                  className={`${FIELD_INPUT_CLASS} w-[180px]`}
                >
                  {RESTRICT_FIELD_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {RESTRICT_FIELD_LABELS[name]}
                    </option>
                  ))}
                </select>
                {condition.field === 'custom' ? (
                  <input
                    type="text"
                    aria-label={`第 ${index + 1} 条条件的字段路径`}
                    value={condition.path}
                    onChange={(event) => updateCondition(index, { path: event.target.value })}
                    placeholder="data.user_id"
                    maxLength={200}
                    className={`${FIELD_INPUT_CLASS} min-w-[140px] flex-1`}
                  />
                ) : null}
                <input
                  type="text"
                  aria-label={`第 ${index + 1} 条条件的取值`}
                  value={condition.value}
                  onChange={(event) => updateCondition(index, { value: event.target.value })}
                  placeholder="必须等于的值"
                  maxLength={200}
                  className={`${FIELD_INPUT_CLASS} min-w-[140px] flex-1`}
                />
                <button
                  type="button"
                  onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                  className="rounded-full border border-line px-3 py-1.5 text-xs text-ink-600 transition hover:border-danger hover:text-danger"
                >
                  删除
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setConditions([...conditions, { field: 'schoolCode', path: '', value: '' }])
              }
              className="rounded-full border border-line px-3.5 py-1.5 text-xs text-ink-700 transition hover:border-ink-300"
            >
              添加条件
            </button>
            {fieldErrors.restrictConditions ? (
              <p role="alert" className="text-xs text-danger">
                {fieldErrors.restrictConditions}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      </>
      )}
    </div>
  );
}
