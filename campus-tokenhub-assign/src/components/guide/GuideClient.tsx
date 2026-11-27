'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';
import { loadActiveKey } from '@/lib/portal/key-cache';
import { renderCurl, renderNode, renderPython } from '@/lib/playground/snippets';
import { appPath } from '@/lib/paths';
import { formatTokens } from '@/lib/portal/usage-format';
import {
  buildWorkBuddyDownload,
  buildWorkBuddyEntry,
  buildWorkBuddyFetchCommand,
  buildWorkBuddyScriptUrl,
  type GuideModel,
  type WorkBuddyModelEntry,
  type WorkBuddyScriptPlatform,
} from '@/lib/guide/workbuddy';

type Tab = 'curl' | 'python' | 'node';

const TABS: { key: Tab; label: string }[] = [
  { key: 'curl', label: 'cURL' },
  { key: 'python', label: 'Python' },
  { key: 'node', label: 'Node.js' },
];

/** 目录还没读到 / 一个对话模型都没有时，示例里用占位符，避免示例跑不起来还看不出来 */
const MODEL_PLACEHOLDER = 'your-model-id';

/** 示例请求体：与调试台默认值保持一致，复制即可运行 */
const SAMPLE_MESSAGES = [{ role: 'user' as const, content: '你好，请用一句话介绍你自己。' }];

/**
 * WorkBuddy 添加模型的截图（客户端真实界面）。
 * 尺寸写死是为了首屏不抖动；点开可看原图。图注在渲染处按当前选中模型生成。
 */
const WORKBUDDY_SHOTS = [
  {
    src: '/guide/workbuddy-model-settings.png',
    width: 1080,
    height: 816,
    alt: 'WorkBuddy 设置中的「模型」页，右上角是「添加模型」按钮',
  },
  {
    src: '/guide/workbuddy-add-model.png',
    width: 1080,
    height: 1013,
    alt: 'WorkBuddy「添加模型」弹窗，接口地址、API Key、模型名称与工具调用开关',
  },
];

/** 上下文/输出上限：统一走 `lib/portal/usage-format`，避免各页面 K/M 口径不一致 */
function tokensLabel(value: number): string {
  return formatTokens(value);
}

/**
 * 把脚本当文件下载：不落服务端、不留链接，Key 只在这个浏览器的内存里。
 * macOS 下的是 zip（内含 755 的 .command）：浏览器没法给下载文件设可执行位，
 * 只有打包后由 Finder 解压才能还原权限，双击才直接可运行。
 */
function downloadWorkBuddyFile(platform: WorkBuddyScriptPlatform, entries: WorkBuddyModelEntry[]): void {
  const { fileName, mimeType, bytes } = buildWorkBuddyDownload(platform, entries);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function InfoRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
      <div className="sm:w-28 sm:shrink-0">
        <div className="text-xs font-medium text-ink-700">{label}</div>
        {hint ? <div className="text-[11px] text-ink-500">{hint}</div> : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

export function GuideClient({
  proxyBase,
  models,
  portalBaseUrl,
}: {
  proxyBase: string;
  models: GuideModel[];
  /** 门户对外地址（含部署前缀），用于拼「方式一」命令里的脚本下载 URL */
  portalBaseUrl: string;
}) {
  // WorkBuddy 只能调用输出文本的模型：嵌入 / 生图 / 生视频 / 语音类只能直接调接口或封装 Skill，
  // 这里先把可接入的挑出来，默认选中、全选、命令参数都只认这一批。
  const selectableModels = models.filter((model) => !model.workbuddyBlockedReason);
  const selectableIds = selectableModels.map((model) => model.id);

  const [modelId, setModelId] = useState(selectableModels[0]?.id ?? models[0]?.id ?? '');
  const [tab, setTab] = useState<Tab>('curl');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyState, setKeyState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  // WorkBuddy 脚本默认把可接入的模型都写进去，用户可以在下面逐个勾掉
  const [scriptModelIds, setScriptModelIds] = useState<string[]>(() => selectableIds);
  // 置灰模型悬浮/聚焦时的提示：贴着行显示，用 fixed 定位避开列表滚动容器的裁剪
  const [blockedHint, setBlockedHint] = useState<{
    text: string;
    top: number;
    left: number;
    placement: 'above' | 'below';
  } | null>(null);

  // Key 只在浏览器里取，不进 SSR HTML；与调试台、模型详情共用同一份内存缓存
  useEffect(() => {
    let cancelled = false;
    loadActiveKey().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setApiKey(result.key);
        setKeyState('ready');
        return;
      }
      setKeyState('missing');
      setKeyMessage(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const baseUrl = `${proxyBase}/v1`;
  // 完整请求地址：给 WorkBuddy 这类「接口地址」要求填完整 URL 的客户端用
  const chatEndpoint = `${baseUrl}/chat/completions`;
  const effectiveModelId = modelId || MODEL_PLACEHOLDER;
  // 只有真拿到 Key 才能拼出可直接执行的命令；否则命令里的 $PORTAL_KEY 是空的，执行必然 401
  const hasKey = keyState === 'ready' && Boolean(apiKey);
  // 手动接入要按「接入信息」里选中的这个模型给出图片输入 / 上下文等参数
  const manualModel = models.find((model) => model.id === modelId) ?? null;

  const body = useMemo(
    () => ({
      model: effectiveModelId,
      messages: SAMPLE_MESSAGES,
      max_tokens: 1024,
      stream: false,
    }),
    [effectiveModelId]
  );

  const snippet = useMemo(() => {
    const input = { baseUrl: proxyBase, path: '/v1/chat/completions', body, apiKey };
    if (tab === 'python') return renderPython(input);
    if (tab === 'node') return renderNode(input);
    return renderCurl(input);
  }, [apiKey, body, proxyBase, tab]);

  // 脚本里要带上勾选的模型 + 真实 Key；缺任意一个都不给下载，避免下下来跑不通
  const workBuddyEntries = useMemo(() => {
    if (!apiKey) return [];
    return models
      .filter((model) => scriptModelIds.includes(model.id))
      .map((model) =>
        buildWorkBuddyEntry({
          modelId: model.id,
          modelName: model.name,
          endpoint: chatEndpoint,
          apiKey,
          supportsImages: model.supportsImages,
          supportsReasoning: model.supportsReasoning,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens,
        })
      );
  }, [apiKey, chatEndpoint, models, scriptModelIds]);

  // 默认全选时不带 models 参数（服务端按「全部可接入模型」处理），命令能短一截
  const scriptModelParam = useMemo(
    () => (scriptModelIds.length === selectableIds.length ? [] : scriptModelIds),
    [scriptModelIds, selectableIds.length]
  );

  // 方式一：直接从门户拉脚本执行，本地不需要预先下载包
  const workBuddyCommands = useMemo(() => {
    const key = apiKey ?? '$PORTAL_KEY';
    return (['mac', 'windows'] as const).map((platform) => ({
      platform,
      command: buildWorkBuddyFetchCommand(
        platform,
        buildWorkBuddyScriptUrl(portalBaseUrl, platform, scriptModelParam),
        key
      ),
    }));
  }, [apiKey, portalBaseUrl, scriptModelParam]);

  function toggleScriptModel(id: string): void {
    setScriptModelIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  }

  /**
   * 置灰模型的悬浮/聚焦提示：说明为什么不能勾，以及该怎么用。
   * 用 fixed 定位（贴着当前行），避免被列表的滚动容器裁掉。
   */
  function showBlockedHint(
    event: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>,
    reason: string
  ): void {
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = rect.top > 96 ? 'above' : 'below';
    setBlockedHint({
      text: `${reason}，无法接入 WorkBuddy。WorkBuddy 只能使用输出文本的对话模型；如需使用该模型，请直接调用接口，或封装成 Skill 接入。`,
      placement,
      top: placement === 'above' ? rect.top - 6 : rect.bottom + 6,
      left: Math.max(12, Math.min(rect.left + 24, window.innerWidth - 320)),
    });
  }

  return (
    <>
      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink-900">快速验证</h2>
            <p className="mt-0.5 text-[11px] text-ink-500">
              {hasKey
                ? '下方示例已包含当前 Key，可直接复制运行。'
                : keyState === 'loading'
                  ? '正在读取你的 API Key…'
                  : '尚未创建 API Key，请先在「我的算力」创建后再复制。'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1 rounded-full bg-cream-100 p-1">
              {TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTab(item.key)}
                  aria-pressed={tab === item.key}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    tab === item.key
                      ? 'bg-ink-900 font-medium text-white shadow-card'
                      : 'text-ink-500 hover:text-ink-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <CopyButton value={snippet} label="复制" />
          </div>
        </div>

        <pre className="scroll-x mt-3 rounded-card bg-ink-900 p-4 text-xs leading-relaxed text-slate-100">
          <code>{snippet}</code>
        </pre>
      </section>

      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink-900">接入信息</h2>
          <span className="text-[11px] text-ink-500">
            以下参数用于客户端的「自定义模型 / OpenAI 兼容」配置；接口地址可填写 Base URL 或完整请求地址，以客户端要求为准
          </span>
        </div>

        <div className="mt-4 space-y-4">
          <InfoRow label="模型 Base URL" hint="OpenAI 兼容">
            <code className="scroll-x min-w-0 flex-1 rounded-control border border-line bg-cream-100 px-3 py-2.5 font-mono text-xs text-ink-900">
              {baseUrl}
            </code>
            <CopyButton value={baseUrl} label="复制" />
          </InfoRow>

          <InfoRow label="请求地址" hint="完整路径">
            <code className="scroll-x min-w-0 flex-1 rounded-control border border-line bg-cream-100 px-3 py-2.5 font-mono text-xs text-ink-900">
              {chatEndpoint}
            </code>
            <CopyButton value={chatEndpoint} label="复制" />
          </InfoRow>

          <InfoRow label="模型 ID" hint="不可自定义名称">
            {models.length > 1 ? (
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                aria-label="选择模型 ID"
                className="min-w-0 flex-1 rounded-control border border-line bg-white px-3 py-2.5 font-mono text-xs text-ink-900 outline-none focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15"
              >
                {models.map((model) => (
                  <option
                    key={model.id}
                    value={model.id}
                    disabled={Boolean(model.workbuddyBlockedReason)}
                    title={model.workbuddyBlockedReason ?? undefined}
                  >
                    {model.id}
                    {model.name && model.name !== model.id ? `（${model.name}）` : ''}
                    {model.workbuddyBlockedReason ? ' · 不可接入 WorkBuddy' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <code className="scroll-x min-w-0 flex-1 rounded-control border border-line bg-cream-100 px-3 py-2.5 font-mono text-xs text-ink-900">
                {models[0]?.id ?? MODEL_PLACEHOLDER}
              </code>
            )}
            <CopyButton value={effectiveModelId} label="复制" />
          </InfoRow>

          <InfoRow label="API Key" hint="仅本人可用">
            {keyState === 'ready' && apiKey ? (
              <>
                <code className="scroll-x min-w-0 flex-1 rounded-control border border-line bg-cream-100 px-3 py-2.5 font-mono text-xs text-ink-900">
                  {apiKey}
                </code>
                <CopyButton value={apiKey} label="复制" />
              </>
            ) : (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <span className="text-xs text-ink-500">
                  {keyState === 'loading' ? '读取中…' : (keyMessage ?? '暂无可用密钥')}
                </span>
                {keyState === 'missing' && (
                  <Link
                    href="/overview"
                    className="rounded-full border border-line bg-white px-3 py-1 text-xs font-medium text-brand-link transition hover:border-ink-300"
                  >
                    去我的算力创建
                  </Link>
                )}
              </div>
            )}
          </InfoRow>
        </div>

        <p className="mt-4 rounded-control bg-cream/70 px-3 py-2 text-[11px] leading-relaxed text-ink-500">
          门户仅提供 API Key 与接入说明；推理请求由客户端直接发出，不经过门户。模型名称须与模型 ID 完全一致，添加前缀或后缀将返回「模型不存在」。
        </p>
      </section>

      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold text-ink-900">一键接入 WorkBuddy</h2>

        <div className="mt-3 rounded-control border border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <span className="text-[11px] font-medium text-ink-700">选择写入的模型（仅文本模型可勾选）</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-500">
                已选 {scriptModelIds.length} / {selectableIds.length}
              </span>
              <button
                type="button"
                onClick={() => setScriptModelIds([...selectableIds])}
                className="rounded-full border border-line bg-white px-2.5 py-0.5 text-[11px] text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
              >
                全选
              </button>
              <button
                type="button"
                onClick={() => setScriptModelIds([])}
                className="rounded-full border border-line bg-white px-2.5 py-0.5 text-[11px] text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
              >
                清空
              </button>
            </div>
          </div>
          {models.length === 0 ? (
            <p className="px-3 py-3 text-[11px] text-ink-500">当前目录暂无可用对话模型。</p>
          ) : (
            <>
              <ul className="max-h-56 divide-y divide-line overflow-auto">
                {models.map((model) => {
                  const blocked = Boolean(model.workbuddyBlockedReason);
                  const hint = model.workbuddyBlockedReason
                    ? `${model.workbuddyBlockedReason}，无法接入 WorkBuddy；可改为直接调用接口或封装成 Skill 使用`
                    : undefined;

                  return (
                    <li key={model.id} className="h-7">
                      <label
                        title={hint}
                        onMouseEnter={
                          blocked && model.workbuddyBlockedReason
                            ? (event) => showBlockedHint(event, model.workbuddyBlockedReason as string)
                            : undefined
                        }
                        onMouseLeave={blocked ? () => setBlockedHint(null) : undefined}
                        onFocus={
                          blocked && model.workbuddyBlockedReason
                            ? (event) => showBlockedHint(event, model.workbuddyBlockedReason as string)
                            : undefined
                        }
                        onBlur={blocked ? () => setBlockedHint(null) : undefined}
                        className={`flex h-full items-center gap-2.5 px-3 transition ${
                          blocked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-cream/60'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={!blocked && scriptModelIds.includes(model.id)}
                          disabled={blocked}
                          onChange={() => toggleScriptModel(model.id)}
                          className="h-3.5 w-3.5 shrink-0 accent-ink-900 disabled:cursor-not-allowed"
                        />
                        <span
                          className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                            blocked ? 'text-ink-400' : 'text-ink-900'
                          }`}
                        >
                          {model.id}
                        </span>
                        {blocked ? (
                          <span className="shrink-0 rounded-full border border-line bg-cream-100 px-1.5 py-0.5 text-[10px] leading-none text-ink-400">
                            不可接入
                          </span>
                        ) : null}
                        {model.name !== model.id ? (
                          <span
                            className={`max-w-[45%] shrink-0 truncate text-[11px] ${
                              blocked ? 'text-ink-400' : 'text-ink-500'
                            }`}
                          >
                            {model.name}
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="border-t border-line px-3 py-1.5 text-[11px] leading-relaxed text-ink-500">
                仅支持输出文本的对话模型接入 WorkBuddy；向量嵌入、文生图 / 文生视频、语音类模型已置灰，需直接调用接口或封装成 Skill 使用。
              </p>
              <p className="border-t border-line px-3 py-1.5 text-[11px] leading-relaxed text-ink-500">
                重新执行会按当前勾选同步：未勾选的门户模型会从 WorkBuddy 移除，其它来源的模型不受影响。
              </p>
            </>
          )}
        </div>

        <div className="mt-4 rounded-control border border-line bg-cream/60 p-3">
          <div className="text-xs font-medium text-ink-900">方式一 · 复制命令执行</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
            在终端粘贴执行，脚本自动从门户获取，不需要预先下载，也不会触发系统拦截。
          </p>
          {hasKey ? null : (
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
              命令里的密钥取自你的 API Key，还没有的话请先
              <Link href="/overview" className="mx-0.5 font-medium text-brand-link hover:underline">
                去「我的算力」创建
              </Link>
              ，否则执行会返回 401。
            </p>
          )}
          <div className="mt-2 space-y-2">
            {workBuddyCommands.map(({ platform, command }) => (
              <div key={platform}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-ink-700">
                    {platform === 'mac' ? 'macOS / Linux' : 'Windows'}
                  </span>
                  <CopyButton value={command} label="复制命令" disabled={!hasKey} />
                </div>
                <code className="mt-1 block whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-900">
                  {command}
                </code>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-2.5 rounded-control border border-line bg-cream/60 p-3">
          <div className="text-xs font-medium text-ink-900">方式二 · 双击运行</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
            下载脚本到本地后双击执行；首次运行会被系统拦截一次，需按下方说明手动解除。
          </p>
          <div className="mt-2 space-y-2">
            {(['mac', 'windows'] as const).map((platform) => (
              <div
                key={platform}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 first:border-0 first:pt-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-medium text-ink-700">
                    {platform === 'mac' ? 'macOS' : 'Windows'}
                  </div>
                  <div className="text-[11px] leading-relaxed text-ink-500">
                    {platform === 'mac'
                      ? '下载为 zip，解压后双击 workbuddy-connect.command；被拦截时前往「系统设置 → 隐私与安全性」选择「仍要打开」。'
                      : '下载后右键「使用 PowerShell 运行」；被拦截时右键文件 → 属性 → 勾选「解除锁定」。'}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={workBuddyEntries.length === 0}
                  onClick={() => workBuddyEntries.length > 0 && downloadWorkBuddyFile(platform, workBuddyEntries)}
                  className="shrink-0 rounded-full bg-ink-900 px-3 py-1 text-xs font-medium text-white shadow-card transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下载脚本
                </button>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
          {apiKey && workBuddyEntries.length > 0
            ? `已包含当前 Key 与 ${workBuddyEntries.length} 个模型，请勿转交他人使用。`
            : apiKey
              ? '请至少选择一个模型。'
              : '暂未获取到可用 Key，请先在「我的算力」创建。'}
        </p>

        <ol className="mt-4 space-y-2 text-xs leading-relaxed text-ink-600">
          <li>
            <span className="font-medium text-ink-900">1. 退出 WorkBuddy：</span>macOS 请使用 ⌘Q 完全退出，Windows 请连同托盘图标一并退出。
          </li>
          <li>
            <span className="font-medium text-ink-900">2. 执行上方任一方式：</span>
            方式一在终端粘贴命令；方式二下载后按对应说明双击运行并解除安全拦截。
          </li>
          <li>
            <span className="font-medium text-ink-900">3. 重新打开 WorkBuddy，进入「设置 → 模型」：</span>
            脚本写入的模型会直接出现在列表中，选中后发送一条消息，收到回复即表示接入成功。
          </li>
        </ol>
      </section>

      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold text-ink-900">手动接入 WorkBuddy</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
          不使用脚本时，可在客户端中自行添加：接口地址与 API Key 取上方「接入信息」，模型名称须与模型 ID 完全一致。
        </p>

        <ol className="mt-3 space-y-4 text-xs leading-relaxed text-ink-600">
          <li>
            <span className="font-medium text-ink-900">1. 打开「设置 → 模型」，点击右上角「添加模型」。</span>
            <figure className="mt-2">
              <a
                href={appPath(WORKBUDDY_SHOTS[0].src)}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-control border border-line transition hover:border-ink-300"
              >
                {/* 截图是本地静态图，点击可看原图；不用 next/image：standalone 镜像里没装 sharp，
                    走图片优化接口会在运行时 500，这里直接由 public/ 静态托管 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={appPath(WORKBUDDY_SHOTS[0].src)}
                  alt={WORKBUDDY_SHOTS[0].alt}
                  width={WORKBUDDY_SHOTS[0].width}
                  height={WORKBUDDY_SHOTS[0].height}
                  loading="lazy"
                  className="h-auto w-full"
                />
              </a>
            </figure>
          </li>
          <li>
            <span className="font-medium text-ink-900">2. 按下列参数填写并保存：</span>
            <dl className="mt-2 space-y-1.5 rounded-control bg-cream/60 p-3 text-[11px] leading-relaxed">
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">接口地址</dt>
                <dd className="min-w-0 flex-1 text-ink-900">上方的「请求地址」</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">API Key</dt>
                <dd className="min-w-0 flex-1 text-ink-900">上方的 Key，可先点「测试连接」验证</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">模型名称</dt>
                <dd className="min-w-0 flex-1">
                  <code className="rounded bg-cream-100 px-1 font-mono text-[11px] text-ink-900">
                    {effectiveModelId}
                  </code>
                  <span className="ml-1 text-ink-500">（须与模型 ID 完全一致）</span>
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">工具调用</dt>
                <dd className="min-w-0 flex-1 text-ink-900">勾选</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">图片输入</dt>
                <dd className="min-w-0 flex-1 text-ink-900">
                  {manualModel?.supportsImages
                    ? '勾选（目录显示该模型支持图片输入）'
                    : '不勾选（目录未显示支持图片输入）'}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">思考模式</dt>
                <dd className="min-w-0 flex-1 text-ink-900">
                  {manualModel?.supportsReasoning
                    ? '勾选（官方标注该模型支持深度思考）'
                    : '不勾选（官方未标注深度思考）'}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">自定义协议</dt>
                <dd className="min-w-0 flex-1 text-ink-900">不勾选</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">输入（上下文）</dt>
                <dd className="min-w-0 flex-1 text-ink-900">
                  {manualModel?.maxInputTokens
                    ? `${manualModel.maxInputTokens}（约 ${tokensLabel(manualModel.maxInputTokens)}）`
                    : '目录未提供该值，可留空使用提供商默认值'}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-[7.5rem] shrink-0 text-ink-500">输出（单次上限）</dt>
                <dd className="min-w-0 flex-1 text-ink-900">
                  {manualModel?.maxOutputTokens
                    ? `${manualModel.maxOutputTokens}（约 ${tokensLabel(manualModel.maxOutputTokens)}）`
                    : '目录未提供该值，可留空使用提供商默认值'}
                </dd>
              </div>
            </dl>
            <figure className="mt-2">
              <a
                href={appPath(WORKBUDDY_SHOTS[1].src)}
                target="_blank"
                rel="noreferrer"
                className="block overflow-hidden rounded-control border border-line transition hover:border-ink-300"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={appPath(WORKBUDDY_SHOTS[1].src)}
                  alt={WORKBUDDY_SHOTS[1].alt}
                  width={WORKBUDDY_SHOTS[1].width}
                  height={WORKBUDDY_SHOTS[1].height}
                  loading="lazy"
                  className="h-auto w-full"
                />
              </a>
            </figure>
          </li>
          <li>
            <span className="font-medium text-ink-900">3. 验证：</span>回到对话页选择该模型，发送一条消息，收到回复即表示接入成功。
          </li>
        </ol>
      </section>

      {blockedHint ? (
        <div
          role="tooltip"
          style={{ top: blockedHint.top, left: blockedHint.left }}
          className={`pointer-events-none fixed z-50 w-[19rem] rounded-control bg-ink-900 px-2.5 py-2 text-[11px] leading-relaxed text-slate-100 shadow-card ${
            blockedHint.placement === 'above' ? '-translate-y-full' : ''
          }`}
        >
          {blockedHint.text}
        </div>
      ) : null}
    </>
  );
}
