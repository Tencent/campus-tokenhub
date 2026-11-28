'use client';

/**
 * 设置页外壳：四个 tab + 统一保存。
 *
 * 服务端已经把当前值算好（敏感项只有尾号），这里只负责编辑草稿并提交；
 * 保存成功后 `router.refresh()` 让服务端重新算一遍，避免前端自己拼状态。
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { appPath } from '@/lib/paths';
import type { SettingsPayload } from '@/lib/config/settings-view';
import { validateField } from '@/lib/config/validate-field';
import {
  CONFIG_FIELD_NAMES,
  FIELDS,
  serializeFieldValue,
  type ConfigField,
  type SettingsGroup,
} from '@/lib/config/fields';
import {
  ColorInput,
  FieldRow,
  ImageUpload,
  NumberInput,
  SecretInput,
  SelectInput,
  TextInput,
  Toggle,
} from './fields';
import { LoginPreview } from './LoginPreview';
import { LoginAuthTab, type LoginAuthState } from './LoginAuthTab';

type TabKey = SettingsGroup;

const STATUS_TEXT: Record<string, string> = {
  ok: '已验证',
  failed: '验证失败',
  unverified: '未验证',
};

const STATUS_CLASS: Record<string, string> = {
  ok: 'border-success/30 bg-[#E8F5EE] text-success',
  failed: 'border-rose-200 bg-rose-50 text-danger',
  unverified: 'border-line bg-cream text-ink-500',
};

const TABS: { key: TabKey; label: string }[] = [
  { key: 'school', label: '首页配置' },
  { key: 'quota', label: '额度与限流' },
  { key: 'auth', label: '登录认证' },
];

/** 表单内部一律用字符串草稿，字段 id 仍是类型化的；提交前交给服务端校验与转类型 */
type Draft = Partial<Record<ConfigField, string>>;

/** 普通输入框负责的字段：密钥走 `secretDraft`，Logo 走上传接口 */
const DRAFT_FIELDS: readonly ConfigField[] = CONFIG_FIELD_NAMES.filter(
  (field) => !FIELDS[field].secret && field !== 'logo'
);

const PERMISSION_LABELS: Record<number, string> = {
  1: '查看账单',
  2: '查看余额',
  3: '资金划拨',
  4: '合并出账',
  5: '开票',
  6: '优惠继承',
  7: '代付费',
  8: '成本分析',
  9: '预算管理',
  10: '信用额度设置',
};

function withClearField(prev: ConfigField[], field: ConfigField): ConfigField[] {
  return prev.includes(field) ? prev : [...prev, field];
}

function toDraft(initial: SettingsPayload): Draft {
  const draft: Draft = {};
  for (const field of DRAFT_FIELDS) {
    // 用「当前生效值」回显：只看配置表会把有默认值的项显示成空，
    // 用户一改就把默认值（例如额度周期默认「每月重置」）覆盖掉
    const value = initial.effective[field] ?? initial.values[field];
    if (value === undefined) continue;
    // 结构化字段（登录限制条件）以 JSON 文本承载，数组 join 会变成 [object Object]
    draft[field] = FIELDS[field].type === 'conditions'
      ? serializeFieldValue(field, value)
      : Array.isArray(value) ? value.join(', ') : String(value);
  }
  return draft;
}

export function SettingsShell({
  initial,
  loginState,
  callbackUrl,
}: {
  initial: SettingsPayload;
  /** 当前生效的登录方式状态（服务端算；保存后随 router.refresh() 更新） */
  loginState: LoginAuthState;
  /** 企微后台登记的回调地址，由服务端按 PUBLIC_BASE_URL 算出 */
  callbackUrl: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('school');
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  /** 用户改过的字段：保存时只提交这些，避免把只是「回显默认值」的项写成 DB 覆盖 */
  const [dirty, setDirty] = useState<Set<ConfigField>>(() => new Set());
  const [secretDraft, setSecretDraft] = useState<Partial<Record<ConfigField, string>>>({});
  const [clearKeys, setClearKeys] = useState<ConfigField[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [applyingRateLimit, setApplyingRateLimit] = useState(false);
  const [overwriteRateLimit, setOverwriteRateLimit] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ConfigField, string>>>({});
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  /** 服务端当前值（草稿的对比基线）：用来判断某个键是不是真被改过 */
  const baseline = useMemo(() => toDraft(initial), [initial]);
  const activeTab: TabKey = tab;
  const hasChanges =
    dirty.size > 0 ||
    clearKeys.length > 0 ||
    Object.values(secretDraft).some((value) => value.trim().length > 0);

  const set = (field: ConfigField, value: string) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setDirty((prev) => {
      // 改回原值时算「没改」：勾了又取消不该让保存按钮一直亮着
      const next = new Set(prev);
      if (baseline[field] !== undefined && value === baseline[field]) next.delete(field);
      else next.add(field);
      return next;
    });
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setMessage(null);
  };

  /** 失焦即时校验：把错误放在字段下方，而不是等保存 */
  const validateOnBlur = (field: ConfigField) => {
    const raw = draft[field] ?? '';
    const error = validateField(field, raw);
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (error) next[field] = error.message;
      else delete next[field];
      return next;
    });
  };

  /**
   * 探测网关计费币种（统一采买站只剩这一个外部依赖）。
   *
   * 只在用户点按钮时触发：结论由服务端记进分组验证状态，刷新后徽标同步。
   */
  async function runProbe(group: 'currency'): Promise<void> {
    setProbing(true);
    setProbe(null);
    try {
      const draft = {};
      const response = await fetch(appPath('/api/portal/settings/probe'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ group, draft }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string | null;
        detail?: {
          root?: { nodeId: number; name: string };
          nodeCount?: number;
          multipleRoots?: boolean;
          currency?: string;
        };
      };
      if (!response.ok) {
        setProbe({ kind: 'error', text: body.error ?? '探测失败，请稍后重试' });
        return;
      }
      if (group === 'currency') {
        const currency = body.detail?.currency ?? 'CNY';
        setProbe({
          kind: 'ok',
          text: body.message ?? `网关计费币种为 ${currency}，默认额度按该币种填写`,
        });
        return;
      }
      const root = body.detail?.root;
      const extra = body.detail?.multipleRoots ? '（检测到多个根节点，已取编号最小者）' : '';
      setProbe({
        kind: 'ok',
        text: root
          ? `凭据有效：根节点「${root.name}」（ID ${root.nodeId}），共 ${body.detail?.nodeCount ?? 0} 个节点${extra}`
          : '凭据有效',
      });
    } catch {
      setProbe({ kind: 'error', text: '网络异常，请稍后重试' });
    } finally {
      setProbing(false);
      // 徽标读的是服务端验证状态：探测后刷新，避免仍显示上一次的结论
      router.refresh();
    }
  }

  async function uploadLogo(file: File): Promise<void> {
    setMessage(null);
    try {
      const response = await fetch(appPath('/api/portal/settings/logo'), {
        method: 'POST',
        headers: { 'content-type': file.type },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage({ kind: 'error', text: body.error ?? '上传失败，请稍后重试' });
        return;
      }
      setMessage({ kind: 'ok', text: 'Logo 已更新' });
      router.refresh();
    } catch {
      setMessage({ kind: 'error', text: '网络异常，请稍后重试' });
    }
  }

  /** 把默认限流补写到存量用户：只补没有限流的，已配置的跳过。 */
  async function applyDefaultRateLimit(): Promise<void> {
    setApplyingRateLimit(true);
    setMessage(null);
    try {
      const response = await fetch(appPath('/api/portal/settings/apply-default-rate-limit'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ overwrite: overwriteRateLimit }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        updated?: number;
        overwritten?: number;
        skipped?: number;
        failed?: number;
      };
      if (!response.ok) {
        setMessage({ kind: 'error', text: body.error ?? '补写失败，请稍后重试' });
        return;
      }
      const parts = [`已写入 ${body.updated ?? 0} 个用户`];
      if (body.overwritten) parts.push(`其中覆盖 ${body.overwritten} 个已有配置`);
      if (body.skipped) parts.push(`跳过 ${body.skipped} 个（已配置限流）`);
      if (body.failed) parts.push(`失败 ${body.failed} 个`);
      setMessage({ kind: 'ok', text: parts.join('，') });
      router.refresh();
    } catch {
      setMessage({ kind: 'error', text: '网络异常，请稍后重试' });
    } finally {
      setApplyingRateLimit(false);
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      const values: Partial<Record<ConfigField, unknown>> = {};
      const clear = new Set(clearKeys);

      for (const field of DRAFT_FIELDS) {
        // 只提交**改动过**的字段。
        // 早先这里把回显出来的全部字段都塞进 payload，导致改一个学校名称也会带上整份
        // 登录配置；后端按「本次提交里含 login 字段」触发了 SSO 完整性校验，
        // 于是缺 Client Secret 的部署连品牌文案都保存不了（报「Client Secret 不能为空」）。
        if (!dirty.has(field)) continue;
        const raw = draft[field];
        if (raw === undefined) continue;
        if (!raw.trim()) {
          // 文本框留空 = 清除该字段，回落到 env / 默认值
          clear.add(field);
          continue;
        }
        values[field] = raw;
      }

      for (const [field, raw] of Object.entries(secretDraft) as [ConfigField, string][]) {
        if (raw.trim()) values[field] = raw.trim();
      }

      const response = await fetch(appPath('/api/portal/settings'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values, clear: [...clear] }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        login_closed?: boolean;
      };
      if (!response.ok) {
        setMessage({ kind: 'error', text: body.error ?? '保存失败，请稍后重试' });
        return;
      }

      if (body.login_closed) {
        // 这次保存让 SSO 变齐全：引导期密码登录已关闭，本会话也已作废。
        // 直接整页跳到登录页，不依赖 router.refresh() 的那次请求（它可能仍在旧配置快照上渲染）。
        window.location.assign(appPath('/login?error=password_disabled'));
        return;
      }

      setSecretDraft({});
      setClearKeys([]);
      setDirty(new Set());
      setMessage({ kind: 'ok', text: '已保存，新配置立即生效（多副本部署最迟 30 秒）' });
      router.refresh();
    } catch {
      setMessage({ kind: 'error', text: '网络异常，请稍后重试' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-[26px] font-semibold leading-9 tracking-tight text-ink-900">设置</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
          这里的配置保存即生效，不需要重建镜像；列表里没有的项（构建期前缀、容器拓扑、数据库连接）属于部署参数，只能由运维改环境变量。
        </p>
        {initial.brokenFields.length > 0 ? (
          <p className="mt-3 rounded-control border border-rose-200 bg-rose-50 px-4 py-3 text-xs leading-relaxed text-rose-700">
            以下配置无法解密或解析，已回落默认值，请重新填写：{initial.brokenFields.join('、')}
          </p>
        ) : null}
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="设置分组">
        {TABS.map((item) => {
          // 没有探测手段的分组（首页配置 / 登录认证）不给状态，避免永远是「未验证」误导成配置有问题
          const status = initial.groupStatus[item.key];
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setTab(item.key);
                // 上一个 tab 的保存结果/探测结果不该跟着跑到下一个 tab
                setMessage(null);
                setProbe(null);
              }}
              aria-current={activeTab === item.key ? 'page' : undefined}
              className={`rounded-full border px-3.5 py-1.5 text-xs transition ${
                activeTab === item.key
                  ? 'border-ink-900 bg-ink-900 text-white'
                  : 'border-line bg-white text-ink-600 hover:border-ink-300 hover:text-ink-900'
              }`}
            >
              {item.label}
              {status ? (
                <span
                  className={`ml-1.5 rounded-full border px-1.5 py-0.5 text-[10px] ${STATUS_CLASS[status]}`}
                >
                  {STATUS_TEXT[status]}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <section className="space-y-5 rounded-card border border-line bg-white p-6 shadow-card">
        {activeTab === 'school' ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-5">
            <FieldRow label="学校名称" hint="登录方返回真实校名时以登录值为准">
              <TextInput
                value={draft['schoolName'] ?? ''}
                onChange={(next) => set('schoolName', next)}
                onBlur={() => validateOnBlur('schoolName')}
                maxLength={60}
                error={Boolean(fieldErrors['schoolName'])}
                placeholder="某某大学"
              />
            </FieldRow>
            <FieldRow label="登录页标题">
              <TextInput
                value={draft['loginTitle'] ?? ''}
                onChange={(next) => set('loginTitle', next)}
                maxLength={60}
              />
            </FieldRow>
            <FieldRow label="登录页副标题">
              <TextInput
                value={draft['loginSubtitle'] ?? ''}
                onChange={(next) => set('loginSubtitle', next)}
                maxLength={120}
              />
            </FieldRow>
            <FieldRow label="页脚联系窗口" hint="例如「账号无法登录？联系信息化办公室 010-xxxx」">
              <TextInput
                value={draft['footerContact'] ?? ''}
                onChange={(next) => set('footerContact', next)}
                maxLength={120}
              />
            </FieldRow>
            <FieldRow label="学校 Logo" hint="显示在登录页左上角与侧边栏">
              <ImageUpload
                logoUrl={initial.logoUrl}
                disabled={saving}
                onUpload={uploadLogo}
              />
            </FieldRow>
            <FieldRow
              label="登录数据统计"
              hint="开启后才采集两站的登录与页面访问；关闭时管理台「分析 → 登录数据」入口隐藏"
            >
              <Toggle
                label="启用登录数据统计"
                checked={(draft['activityEnabled'] ?? 'false') !== 'false'}
                onChange={(next) => set('activityEnabled', String(next))}
              />
            </FieldRow>
            <FieldRow
              label="主题色"
              hint="十六进制颜色，例如 #2557D6"
              error={fieldErrors['brandColor']}
            >
              <ColorInput
                value={draft['brandColor'] ?? ''}
                onChange={(next) => set('brandColor', next)}
                onBlur={() => validateOnBlur('brandColor')}
                error={Boolean(fieldErrors['brandColor'])}
              />
            </FieldRow>
            </div>

            <div className="lg:sticky lg:top-4 lg:self-start">
              <LoginPreview
                schoolName={draft['schoolName'] ?? ''}
                loginTitle={draft['loginTitle'] ?? ''}
                loginSubtitle={draft['loginSubtitle'] ?? ''}
                footerContact={draft['footerContact'] ?? ''}
                brandColor={draft['brandColor'] ?? ''}
                logoUrl={initial.logoUrl}
              />
            </div>
          </div>
        ) : null}

        {activeTab === 'quota' ? (
          <div className="max-w-2xl space-y-5">
            <FieldRow
              label="开户默认额度"
              hint="新用户首次登录开户时写入的周期额度。按网关计费币种填写（默认人民币元）；门户里按 1 元 = 100 算力值展示"
            >
              {/* 额度是个小数值，跑满整行会让右侧的「元」离数字太远 */}
              <div className="max-w-[220px]">
                <NumberInput
                  value={draft['defaultBudgetMax'] ?? ''}
                  onChange={(next) => set('defaultBudgetMax', next)}
                  min={0}
                  suffix="元"
                />
              </div>
            </FieldRow>
            <FieldRow label="额度周期">
              <SelectInput
                value={draft['defaultBudgetPeriod'] ?? 'monthly'}
                onChange={(next) => set('defaultBudgetPeriod', next)}
                options={[
                  { value: 'daily', label: '每日重置' },
                  { value: 'monthly', label: '每月重置' },
                  { value: 'none', label: '不重置' },
                ]}
              />
            </FieldRow>
            <FieldRow
              label="开户默认 RPM"
              hint="新用户开户时写入的用户级限流（该用户所有 Key 合计）。留空表示不限；0 表示拒绝全部计次请求。只在建号那一刻写入，之后在网关管理台调整不会被下次登录覆盖"
            >
              <div className="max-w-[220px]">
                <NumberInput
                  value={draft['defaultRateLimitRpm'] ?? ''}
                  onChange={(next) => set('defaultRateLimitRpm', next)}
                  min={0}
                  suffix="次 / 分钟"
                />
              </div>
            </FieldRow>
            <FieldRow
              label="开户默认 TPM"
              hint="同一 60 秒窗口内的 token 吞吐上限。留空表示不限；0 表示拒绝全部会产生 token 消耗的请求。只作用于 Chat / Messages / Responses / Gemini 文本 / Embeddings"
            >
              <div className="max-w-[220px]">
                <NumberInput
                  value={draft['defaultRateLimitTpm'] ?? ''}
                  onChange={(next) => set('defaultRateLimitTpm', next)}
                  min={0}
                  suffix="token / 分钟"
                />
              </div>
            </FieldRow>
            <FieldRow
              label="应用到存量用户"
              hint="把上面两个默认值补写到「当前没有限流配置」的用户；已配置的会被跳过，不会覆盖管理员改过的值"
            >
              <div className="space-y-3">
                <Toggle
                  label="同时刷新已配置限流的用户（覆盖它们的现有值）"
                  checked={overwriteRateLimit}
                  onChange={setOverwriteRateLimit}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void applyDefaultRateLimit()}
                    disabled={applyingRateLimit}
                    className={
                      overwriteRateLimit
                        ? 'rounded-full border border-amber-300 bg-amber-50 px-3.5 py-1.5 text-xs text-amber-800 transition hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-50'
                        : 'rounded-full border border-line px-3.5 py-1.5 text-xs text-ink-700 transition hover:border-ink-300 disabled:cursor-not-allowed disabled:opacity-50'
                    }
                  >
                    {applyingRateLimit
                      ? '写入中…'
                      : overwriteRateLimit
                        ? '覆盖全部用户'
                        : '补写到存量用户'}
                  </button>
                  <span className="text-xs text-ink-400">
                    {overwriteRateLimit
                      ? '会把所有用户的限流改成上面的默认值，管理员在此之外的调整会被覆盖'
                      : '先保存上面的默认值，再点这里；只影响本门户开户的用户，已配置的会跳过'}
                  </span>
                </div>
              </div>
            </FieldRow>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => runProbe('currency')}
                disabled={probing}
                className="rounded-full border border-line px-3.5 py-1.5 text-xs text-ink-700 transition hover:border-ink-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {probing ? '检测中…' : '检测网关币种'}
              </button>
              <span className="text-xs text-ink-400">读取网关当前计费币种，核对默认额度单位</span>
            </div>
            {probe ? (
              <p role="status" className={`text-xs ${probe.kind === 'ok' ? 'text-success' : 'text-danger'}`}>
                {probe.text}
              </p>
            ) : null}
          </div>
        ) : null}

        {activeTab === 'auth' ? (
          <LoginAuthTab
            draft={draft}
            secretDraft={secretDraft}
            fieldErrors={fieldErrors}
            secrets={initial.secrets}
            loginState={loginState}
            callbackUrl={callbackUrl}
            onChange={set}
            onSecretChange={(key, value) => {
              setSecretDraft((prev) => ({ ...prev, [key]: value }));
              // 重新填写即撤销「清除」：否则保存时会先写后删，把新密钥静默删掉
              if (value.trim()) {
                setClearKeys((prev) => prev.filter((item) => item !== key));
              }
            }}
            onBlur={validateOnBlur}
            onClearSecret={(key) => setClearKeys((prev) => withClearField(prev, key))}
          />
        ) : null}

        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving || !hasChanges}
              title={!hasChanges ? '没有改动' : undefined}
              className="rounded-full bg-ink-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:bg-ink-300"
            >
              {saving ? '保存中…' : '保存'}
            </button>
            {message ? (
              <p
                role="status"
                className={`text-xs ${message.kind === 'ok' ? 'text-success' : 'text-danger'}`}
              >
                {message.text}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

