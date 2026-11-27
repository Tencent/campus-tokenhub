'use client';

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { CatalogModel } from '@/lib/gateway/types';
import { classifyModels, flattenOptions, type PlaygroundOption } from '@/lib/playground/classify';
import { PayloadError, buildPayload, type PlaygroundForm } from '@/lib/playground/payload';
import { getBlocked, markBlocked } from '@/lib/playground/allowlist';
import { explainError, readGatewayError } from '@/lib/playground/errors';
import { createSSEParser, parseChatChunk } from '@/lib/playground/stream';
import { renderCurl, renderNode, renderPython } from '@/lib/playground/snippets';
import { imageFamily, KLING_ASPECT_RATIOS, KLING_RESOLUTIONS, SEEDREAM_SIZES } from '@/lib/playground/model-params';
import { loadActiveKey, reloadActiveKey, type ActiveKeyResult } from '@/lib/portal/key-cache';
import { CopyButton } from '@/components/ui/CopyButton';

type ResponseState =
  | { kind: 'idle' }
  | { kind: 'running'; content: string; reasoning: string }
  | { kind: 'chat'; content: string; reasoning: string; usage: unknown; raw: unknown }
  | { kind: 'images'; images: { src: string; b64?: boolean }[]; raw: unknown; elapsedMs: number }
  | { kind: 'embedding'; vectors: number[][]; raw: unknown; elapsedMs: number }
  | { kind: 'error'; title: string; hint: string; raw: string; retryAfter?: number };

const DEFAULT_FORM: PlaygroundForm = {
  system: '',
  // 从密钥页点「调试」进来就是要发一条试试，预填一句省一次打字
  messages: [{ role: 'user', content: '你好，请用一句话介绍你自己。' }],
  temperature: 0.7,
  maxTokens: 1024,
  topP: null,
  stream: true,
  imageUrls: [],
  videoUrl: '',
  prompt: '',
  n: 1,
  responseFormat: 'url',
  size: '',
  aspectRatio: '1:1',
  resolution: '1k',
  negativePrompt: '',
  input: '',
  inputs: [],
};

const optionKey = (option: PlaygroundOption): string => `${option.modelId}#${option.operation}`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-ink-700">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-control border border-line px-2.5 py-1.5 text-xs outline-none transition hover:border-ink-300 focus:border-brand-orange focus:bg-white focus:ring-4 focus:ring-brand-orange/15';

export function PlaygroundClient({
  models,
  proxyBase,
  initialKeyName = null,
  initialModelId = null,
}: {
  models: CatalogModel[];
  proxyBase: string;
  initialKeyName?: string | null;
  /** 从模型详情页点进来时预选的模型 ID */
  initialModelId?: string | null;
}) {
  // 402 命中的模型直接存进 state：既是 useMemo 的真实依赖，也避免用「版本号」当伪依赖
  const [blocked, setBlocked] = useState<string[]>(() => getBlocked());
  const classified = useMemo(() => classifyModels(models, { blocked }), [models, blocked]);
  const options = useMemo(() => flattenOptions(classified), [classified]);

  const [selectedKey, setSelectedKey] = useState<string>('');
  const preferred = useMemo(() => {
    if (selectedKey) return options.find((option) => optionKey(option) === selectedKey);
    if (!initialModelId) return undefined;
    // 同一模型可能有多个 operation，优先落到对话表单
    return (
      options.find((option) => option.modelId === initialModelId && option.operation === 'chat') ??
      options.find((option) => option.modelId === initialModelId)
    );
  }, [initialModelId, options, selectedKey]);
  const current = preferred ?? options[0] ?? null;
  const model = current ? (models.find((item) => item.id === current.modelId) ?? null) : null;

  const [apiKey, setApiKey] = useState<string | null>(null);
  const [keyState, setKeyState] = useState<'loading' | 'ready' | 'none' | 'error'>('loading');
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [keyReloading, setKeyReloading] = useState(false);

  const applyKey = useCallback((result: ActiveKeyResult): void => {
    if (result.ok) {
      setApiKey(result.key);
      setKeyState('ready');
      setKeyMessage(null);
      return;
    }
    setApiKey(null);
    setKeyState(result.code === 'no_key' || result.code === 'not_provisioned' ? 'none' : 'error');
    setKeyMessage(result.error);
  }, []);

  useEffect(() => {
    // 明文一律走 /api/portal/key（带 no-store）：页面 SSR 载荷里只有掩码
    let cancelled = false;
    loadActiveKey().then((result) => {
      if (!cancelled) applyKey(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyKey]);

  async function retryKey(): Promise<void> {
    setKeyReloading(true);
    const result = await reloadActiveKey();
    applyKey(result);
    setKeyReloading(false);
  }

  const [advancedJson, setAdvancedJson] = useState('');
  const [form, setForm] = useState<PlaygroundForm>(DEFAULT_FORM);
  const [response, setResponse] = useState<ResponseState>({ kind: 'idle' });
  const [previewTab, setPreviewTab] = useState<'curl' | 'python' | 'node'>('curl');
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showFullVector, setShowFullVector] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 切换模型/操作后：中止在途请求并清空上次响应，避免旧响应串到新模型
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setForm(DEFAULT_FORM);
    setResponse({ kind: 'idle' });
    setAdvancedJson('');

    // 卸载时同样中止：否则离开页面后 SSE 读取与 rAF 会继续跑并对已卸载组件 setState
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [selectedKey]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const payload = useMemo(() => {
    if (!model || !current) return null;
    try {
      return { ok: true as const, built: buildPayload({ model, operation: current.operation, form, advancedJson }) };
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof PayloadError ? error.message : '请求体构造失败',
      };
    }
  }, [advancedJson, current, form, model]);

  const snippet = useMemo(() => {
    if (!payload?.ok) return '';
    const input = {
      baseUrl: proxyBase,
      path: payload.built.path,
      body: payload.built.body,
      // Key 已读到时直接写真实值，保证复制出去就能跑；没读到时退回占位符
      apiKey: keyState === 'ready' ? apiKey : null,
    };
    if (previewTab === 'python') return renderPython(input);
    if (previewTab === 'node') return renderNode(input);
    return renderCurl(input);
  }, [apiKey, keyState, payload, previewTab, proxyBase]);

  const hasImageInput = (model?.input_modalities ?? []).includes('image');
  const hasVideoInput = (model?.input_modalities ?? []).includes('video');
  const family = current ? imageFamily(current.modelId) : 'generic';

  function update(patch: Partial<PlaygroundForm>): void {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function updateMessage(index: number, patch: Partial<{ role: 'system' | 'user' | 'assistant'; content: string }>): void {
    setForm((prev) => {
      const messages = [...(prev.messages ?? [])];
      messages[index] = { ...messages[index], ...patch };
      return { ...prev, messages };
    });
  }

  async function send(): Promise<void> {
    if (!payload?.ok || !current || !apiKey) return;

    const startedAt = Date.now();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setResponse({ kind: 'running', content: '', reasoning: '' });

    try {
      const res = await fetch(`${proxyBase.replace(/\/+$/, '')}${payload.built.path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload.built.body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const rawText = await res.text().catch(() => '');
        let parsed: { error?: string; message?: string; code?: string } = {};
        try {
          parsed = JSON.parse(rawText) as typeof parsed;
        } catch {
          parsed = { message: rawText.slice(0, 500) };
        }

        const { code, retryAfterSeconds } = readGatewayError(res.headers);
        const effectiveCode = code ?? parsed.code ?? null;
        const explained = explainError({
          status: res.status,
          code: effectiveCode,
          message: parsed.message ?? parsed.error ?? null,
          retryAfterSeconds,
        });

        // 402 未开通后付费：本次会话内不再展示该模型，避免再次点火熔断
        if (res.status === 402 || effectiveCode === '401007') {
          markBlocked(current.modelId);
          setBlocked(getBlocked());
        }

        // 先判「是否仍是最新请求」再写状态：否则旧请求的 429 冷却会把新请求的按钮也锁住
        if (abortRef.current !== controller) return;
        if (explained.retryAfterSeconds) setCountdown(explained.retryAfterSeconds);
        setResponse({
          kind: 'error',
          title: explained.title,
          hint: explained.hint,
          raw: rawText.slice(0, 4000) || `HTTP ${res.status}`,
          retryAfter: explained.retryAfterSeconds,
        });
        return;
      }

      if (current.operation === 'chat' && form.stream) {
        await consumeStream(res, controller);
      } else {
        const json = (await res.json()) as Record<string, unknown>;
        if (abortRef.current !== controller) return;
        presentSuccess(json, Date.now() - startedAt);
      }
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        // 中止：保留已收到的内容
        return;
      }
      // 旧请求（已被切换/重发取代）的失败不能覆盖新请求的结果
      if (abortRef.current !== controller) return;
      const explained = explainError({ message: (error as Error).message });
      setResponse({ kind: 'error', title: explained.title, hint: explained.hint, raw: (error as Error).message });
    } finally {
      // 只有当前请求仍是最新一次时才复位，避免切换模型后旧请求把 busy 关掉
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  async function consumeStream(res: Response, controller: AbortController): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let content = '';
    let reasoning = '';
    let usage: unknown = null;
    let frame: number | null = null;

    const cancelFrame = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    /** 每个 chunk 都可能触发一次 setState；合并到每帧最多一次，避免长回答时整页反复重渲染 */
    const flush = (): void => {
      frame = null;
      if (abortRef.current !== controller) return;
      startTransition(() => setResponse({ kind: 'running', content, reasoning }));
    };

    const schedule = (): void => {
      if (frame !== null) return;
      frame = requestAnimationFrame(flush);
    };

    const parser = createSSEParser({
      onData: (data) => {
        const delta = parseChatChunk(data);
        if (!delta) return;
        if (delta.reasoning) reasoning += delta.reasoning;
        if (delta.content) content += delta.content;
        if (delta.usage) usage = delta.usage;
        // 切换模型后旧流的增量直接丢弃
        if (abortRef.current !== controller) return;
        schedule();
      },
    });

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.flush();
      cancelFrame();
      if (abortRef.current !== controller) return;
      setResponse({ kind: 'chat', content, reasoning, usage, raw: null });
    } catch (error) {
      cancelFrame();
      if ((error as Error).name === 'AbortError') {
        if (abortRef.current !== controller) return;
        setResponse({ kind: 'chat', content, reasoning, usage, raw: '已中止' });
        return;
      }
      throw error;
    } finally {
      cancelFrame();
      controller.abort();
    }
  }

  function presentSuccess(json: Record<string, unknown>, elapsedMs: number): void {
    if (current?.operation === 'images.generations') {
      const rows = (json.data as { url?: string; b64_json?: string }[] | undefined) ?? [];
      const images = rows
        .map((row) =>
          row.url
            ? { src: row.url }
            : row.b64_json
              ? { src: `data:image/png;base64,${row.b64_json}`, b64: true }
              : null
        )
        .filter((item): item is { src: string; b64?: boolean } => item !== null);
      setResponse({ kind: 'images', images, raw: json, elapsedMs });
      return;
    }

    if (current?.operation === 'embeddings') {
      const rows = (json.data as { embedding?: number[] }[] | undefined) ?? [];
      setResponse({
        kind: 'embedding',
        vectors: rows.map((row) => row.embedding ?? []),
        raw: json,
        elapsedMs,
      });
      return;
    }

    const choice = (json.choices as { message?: { content?: string; reasoning_content?: string } }[] | undefined)?.[0];
    setResponse({
      kind: 'chat',
      content: choice?.message?.content ?? JSON.stringify(json).slice(0, 2000),
      reasoning: choice?.message?.reasoning_content ?? '',
      usage: json.usage ?? null,
      raw: json,
    });
  }

  if (options.length === 0) {
    return (
      <div className="rounded-card border border-line bg-white p-8 text-center">
        <p className="text-sm text-ink-700">暂无可调试的模型</p>
        <p className="mt-1 text-xs text-ink-500">
          管理员还没有开放可调试的模型，或白名单内模型都被标记为不可用。
        </p>
        <Link href="/models" className="mt-3 inline-block text-xs text-brand-link hover:underline">
          查看模型列表
        </Link>
      </div>
    );
  }

  const canSend =
    Boolean(payload?.ok) && Boolean(current?.supported) && !busy && countdown === 0 && keyState === 'ready';

  return (
    <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
      {/* 左：模型与操作 */}
      <aside className="space-y-3 self-start rounded-card border border-line bg-white p-5">
        <div className="text-sm font-semibold text-ink-900">模型</div>
        <select
          value={current ? optionKey(current) : ''}
          onChange={(event) => setSelectedKey(event.target.value)}
          className={inputClass}
        >
          {options.map((option) => (
            <option key={optionKey(option)} value={optionKey(option)}>
              {option.displayName} · {option.operation}
              {option.supported ? '' : '（仅 cURL）'}
            </option>
          ))}
        </select>

        <dl className="space-y-1 text-[11px] text-ink-500">
          <div className="flex justify-between">
            <dt>分组</dt>
            <dd>{current?.group === 'chat' ? '对话' : current?.group === 'image' ? '图像' : '向量'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>模型 ID</dt>
            <dd className="truncate font-mono">{current?.modelId}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Key</dt>
            <dd
              className={
                keyState === 'ready'
                  ? 'text-success'
                  : keyState === 'loading'
                    ? 'text-ink-500'
                    : 'text-danger'
              }
            >
              {keyState === 'ready'
                ? initialKeyName
                  ? `已加载：${initialKeyName}`
                  : '已加载（仅内存）'
                : keyState === 'loading'
                  ? '读取中…'
                  : '未就绪'}
            </dd>
          </div>
        </dl>

        <p className="rounded-lg bg-cream-100 px-2 py-1.5 text-[11px] leading-relaxed text-ink-500">
          请求由浏览器直接发出，门户不经手；Key 只存在当前页面内存里。
        </p>
      </aside>

      {/* 中：表单 */}
      <section className="space-y-3 rounded-card border border-line bg-white p-5">
        {keyState !== 'ready' && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-brand-yellow/40 bg-brand-yellow-soft px-3 py-2 text-xs text-ink-700">
            <span className="min-w-0">
              {keyState === 'loading'
                ? '正在读取你的密钥… 可以先把参数填好。'
                : `${keyMessage ?? '还没有可用的密钥'}，发送前需要先创建。`}
            </span>
            {keyState !== 'loading' && (
              <span className="flex shrink-0 items-center gap-2">
                <Link
                  href="/overview"
                  className="rounded-control border border-brand-yellow/50 bg-white px-2.5 py-1 font-medium text-ink-700 transition hover:bg-brand-yellow-soft"
                >
                  去我的算力创建
                </Link>
                <button
                  type="button"
                  onClick={retryKey}
                  disabled={keyReloading}
                  className="rounded-control border border-brand-yellow/50 bg-white px-2.5 py-1 font-medium text-ink-700 transition hover:bg-brand-yellow-soft disabled:opacity-60"
                >
                  {keyReloading ? '读取中…' : '重新读取'}
                </button>
              </span>
            )}
          </div>
        )}

        {current && !current.supported && (
          <div className="rounded-control border border-brand-yellow/40 bg-brand-yellow-soft px-3 py-2 text-xs text-ink-700">
            该类型暂不支持在线调试（缺上表单一半字段会误导），右侧给了可直接运行的 cURL。
          </div>
        )}

        {current?.operation === 'chat' && (
          <>
            <Field label="System prompt（可选）">
              <textarea
                rows={2}
                value={form.system ?? ''}
                onChange={(event) => update({ system: event.target.value })}
                className={inputClass}
                placeholder="你是一位耐心的助教…"
              />
            </Field>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-ink-700">消息</span>
                <button
                  type="button"
                  onClick={() =>
                    update({ messages: [...(form.messages ?? []), { role: 'user', content: '' }] })
                  }
                  className="rounded-control border border-line px-2 py-0.5 text-[11px] text-ink-600 transition hover:bg-cream-100"
                >
                  添加一条
                </button>
              </div>

              {(form.messages ?? []).map((message, index) => (
                <div key={index} className="flex gap-2">
                  <select
                    value={message.role}
                    onChange={(event) => updateMessage(index, { role: event.target.value as 'user' })}
                    className="w-24 shrink-0 rounded-control border border-line px-2 py-1.5 text-xs"
                  >
                    <option value="user">user</option>
                    <option value="assistant">assistant</option>
                  </select>
                  <textarea
                    rows={2}
                    value={message.content}
                    onChange={(event) => updateMessage(index, { content: event.target.value })}
                    className={inputClass}
                    placeholder="输入内容"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      update({ messages: (form.messages ?? []).filter((_, position) => position !== index) })
                    }
                    className="shrink-0 self-start rounded-control border border-line px-2 py-1 text-[11px] text-ink-500"
                    aria-label="删除这条消息"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>

            {hasImageInput && (
              <Field label="图片 URL（每行一个，上游会自行拉取）">
                <textarea
                  rows={2}
                  value={(form.imageUrls ?? []).join('\n')}
                  onChange={(event) =>
                    update({ imageUrls: event.target.value.split('\n').map((item) => item.trim()).filter(Boolean) })
                  }
                  className={inputClass}
                  placeholder="https://example.com/a.png"
                />
              </Field>
            )}

            {hasVideoInput && (
              <Field label="视频 URL（仅公网可访问地址，不接受本地上传）">
                <input
                  value={form.videoUrl ?? ''}
                  onChange={(event) => update({ videoUrl: event.target.value })}
                  className={inputClass}
                  placeholder="https://example.com/a.mp4"
                />
              </Field>
            )}

            <div className="grid grid-cols-2 gap-2">
              <Field label="temperature">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={form.temperature ?? 0.7}
                  onChange={(event) => update({ temperature: Number(event.target.value) })}
                  className={inputClass}
                />
              </Field>
              <Field label="max_tokens">
                <input
                  type="number"
                  min="1"
                  value={form.maxTokens ?? 1024}
                  onChange={(event) => update({ maxTokens: Number(event.target.value) })}
                  className={inputClass}
                />
              </Field>
              <Field label="top_p（留空则不发送）">
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={form.topP ?? ''}
                  onChange={(event) =>
                    update({ topP: event.target.value === '' ? null : Number(event.target.value) })
                  }
                  className={inputClass}
                />
              </Field>
              <label className="mt-5 flex items-center gap-2 text-xs text-ink-700">
                <input
                  type="checkbox"
                  checked={form.stream ?? true}
                  onChange={(event) => update({ stream: event.target.checked })}
                />
                流式输出
              </label>
            </div>

            {(form.maxTokens ?? 1024) < 256 && (
              <p className="rounded-control bg-brand-yellow-soft px-2 py-1.5 text-[11px] text-ink-700">
                max_tokens 偏小：推理模型可能把 token 全花在思考过程上，正文会是空的。建议 ≥ 1024。
              </p>
            )}
          </>
        )}

        {current?.operation === 'images.generations' && (
          <>
            <Field label="prompt">
              <textarea
                rows={3}
                value={form.prompt ?? ''}
                onChange={(event) => update({ prompt: event.target.value })}
                className={inputClass}
                placeholder="一只在图书馆看书的橘猫，暖色插画风格"
              />
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Field label="n（张数）">
                <input
                  type="number"
                  min="1"
                  max="9"
                  value={form.n ?? 1}
                  onChange={(event) => update({ n: Number(event.target.value) })}
                  className={inputClass}
                />
              </Field>
              <Field label="response_format">
                <select
                  value={form.responseFormat ?? 'url'}
                  onChange={(event) => update({ responseFormat: event.target.value })}
                  className={inputClass}
                >
                  <option value="url">url</option>
                  <option value="b64_json">b64_json</option>
                </select>
              </Field>

              {family === 'seedream' && (
                <Field label="size（Seedream 档位）">
                  <select
                    value={form.size ?? ''}
                    onChange={(event) => update({ size: event.target.value })}
                    className={inputClass}
                  >
                    <option value="">默认</option>
                    {SEEDREAM_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {family === 'kling' && (
                <>
                  <Field label="aspect_ratio">
                    <select
                      value={form.aspectRatio ?? '1:1'}
                      onChange={(event) => update({ aspectRatio: event.target.value })}
                      className={inputClass}
                    >
                      {KLING_ASPECT_RATIOS.map((ratio) => (
                        <option key={ratio} value={ratio}>
                          {ratio}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="resolution">
                    <select
                      value={form.resolution ?? '1k'}
                      onChange={(event) => update({ resolution: event.target.value })}
                      className={inputClass}
                    >
                      {KLING_RESOLUTIONS.map((resolution) => (
                        <option key={resolution} value={resolution}>
                          {resolution}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="negative_prompt">
                    <input
                      value={form.negativePrompt ?? ''}
                      onChange={(event) => update({ negativePrompt: event.target.value })}
                      className={inputClass}
                      placeholder="模糊、低质量"
                    />
                  </Field>
                </>
              )}

              {family === 'generic' && (
                <Field label="size（可选，如 1024x1024）">
                  <input
                    value={form.size ?? ''}
                    onChange={(event) => update({ size: event.target.value })}
                    className={inputClass}
                  />
                </Field>
              )}
            </div>
          </>
        )}

        {current?.operation === 'embeddings' && (
          <>
            <Field label="文本（多于一条时按行拆分成数组）">
              <textarea
                rows={4}
                value={(form.inputs ?? []).length > 0 ? (form.inputs ?? []).join('\n') : (form.input ?? '')}
                onChange={(event) => {
                  const lines = event.target.value.split('\n');
                  if (lines.length > 1) update({ inputs: lines.filter(Boolean), input: '' });
                  else update({ inputs: [], input: event.target.value });
                }}
                className={inputClass}
                placeholder="学校的 AI 平台怎么用？"
              />
            </Field>
            <p className="text-[11px] text-ink-500">
              单条文本走字符串；多条换行后自动按数组发送。维度由模型决定，结果区会显示实际维度。
            </p>
          </>
        )}

        <Field label="高级参数（JSON，冲突时以这里为准）">
          <textarea
            rows={3}
            value={advancedJson}
            onChange={(event) => setAdvancedJson(event.target.value)}
            className={`${inputClass} font-mono`}
            placeholder='{"seed": 42}'
          />
        </Field>
        {!payload?.ok && payload && (
          <p className="text-[11px] leading-4 text-danger">{payload.message}</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className="flex h-9 items-center rounded-control bg-brand-orange px-5 text-[13px] font-medium text-white shadow-cta transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy
              ? '请求中…'
              : countdown > 0
                ? `${countdown}s 后重试`
                : keyState === 'loading'
                  ? '读取密钥中…'
                  : keyState !== 'ready'
                    ? '请先创建密钥'
                    : '发送请求'}
          </button>

          {busy && (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="flex h-9 items-center rounded-control border border-line px-3 text-[13px] text-ink-700 transition hover:bg-cream-100"
            >
              停止
            </button>
          )}
        </div>
      </section>

      {/* 右：结果 + 请求预览 */}
      <section className="space-y-3">
        <div className="rounded-card border border-line bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-900">响应</h2>
            {response.kind === 'images' && <span className="text-[11px] text-ink-500">{response.elapsedMs} ms</span>}
          </div>

          <div className="mt-2 min-h-[160px] text-sm">
            {response.kind === 'idle' && <div className="rounded-control bg-cream/50 px-4 py-6 text-center">
              <p className="text-xs font-medium text-ink-900">还没有发送请求</p>
              <p className="mt-1 text-[11px] leading-4 text-ink-500">在左侧选好模型、填完参数，点「发送请求」就能看到结果。</p>
            </div>}

            {response.kind === 'running' && (
              <div className="space-y-2">
                {response.reasoning && (
                  <p className="whitespace-pre-wrap rounded-lg bg-cream-100 p-2 text-[11px] text-ink-500">
                    {response.reasoning}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-ink-900">{response.content || '…'}</p>
              </div>
            )}

            {response.kind === 'chat' && (
              <div className="space-y-2">
                {response.reasoning && (
                  <details className="rounded-lg bg-cream-100 p-2 text-[11px] text-ink-500">
                    <summary className="cursor-pointer">思考过程（reasoning_content）</summary>
                    <pre className="mt-1 whitespace-pre-wrap">{response.reasoning}</pre>
                  </details>
                )}
                {response.content ? (
                  <p className="whitespace-pre-wrap text-ink-900">{response.content}</p>
                ) : (
                  <p className="text-xs text-ink-700">
                    正文为空：推理模型可能把 token 都花在思考过程上，把 max_tokens 调大再试。
                  </p>
                )}
                {response.usage ? (
                  <pre className="scroll-x rounded-lg bg-cream-100 p-2 text-[11px] text-ink-500">
                    {JSON.stringify(response.usage)}
                  </pre>
                ) : null}
              </div>
            )}

            {response.kind === 'images' && (
              <div className="grid grid-cols-2 gap-2">
                {response.images.map((image, index) => (
                  <a
                    key={index}
                    href={image.src}
                    target="_blank"
                    rel="noreferrer"
                    className="block overflow-hidden rounded-lg border border-line"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.src} alt={`生成结果 ${index + 1}`} className="h-full w-full object-cover" />
                  </a>
                ))}
              </div>
            )}

            {response.kind === 'embedding' && (
              <div className="space-y-2">
                <p className="text-xs text-ink-600">
                  共 {response.vectors.length} 条，维度 {response.vectors[0]?.length ?? 0}，耗时 {response.elapsedMs} ms
                </p>
                <pre className="scroll-x rounded-lg bg-cream-100 p-2 text-[11px] text-ink-700">
                  {JSON.stringify(
                    showFullVector ? response.vectors : response.vectors.map((v) => v.slice(0, 8)),
                    null,
                    1
                  )}
                </pre>
                <button
                  type="button"
                  onClick={() => setShowFullVector((value) => !value)}
                  className="text-[11px] text-brand-link hover:underline"
                >
                  {showFullVector ? '收起' : '展开完整向量'}
                </button>
              </div>
            )}

            {response.kind === 'error' && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-danger">{response.title}</p>
                <p className="text-xs leading-relaxed text-ink-600">{response.hint}</p>
                {response.retryAfter ? (
                  <p className="text-xs text-ink-700">冷却中，{response.retryAfter} 秒内请勿再发送。</p>
                ) : null}
                <details className="rounded-lg bg-cream-100 p-2 text-[11px] text-ink-500">
                  <summary className="cursor-pointer">原始响应</summary>
                  <pre className="mt-1 whitespace-pre-wrap">{response.raw}</pre>
                </details>
              </div>
            )}
          </div>

          {(response.kind === 'chat' || response.kind === 'images' || response.kind === 'embedding') && response.raw ? (
            <details className="mt-3 rounded-lg bg-cream-100 p-2 text-[11px] text-ink-500">
              <summary className="cursor-pointer">原始 JSON</summary>
              <pre className="scroll-x mt-1">{JSON.stringify(response.raw, null, 2)}</pre>
            </details>
          ) : null}
        </div>

        <div className="rounded-card border border-line bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-900">请求预览</h2>
            <div className="flex items-center gap-2">
              <select
                value={previewTab}
                onChange={(event) => setPreviewTab(event.target.value as 'curl')}
                className="rounded-md border border-line px-2 py-1 text-[11px]"
              >
                <option value="curl">cURL</option>
                <option value="python">Python</option>
                <option value="node">Node.js</option>
              </select>
              <CopyButton value={snippet} />
            </div>
          </div>
          <pre className="scroll-x mt-2 max-h-72 overflow-y-auto rounded-xl bg-ink-900 p-3 text-[11px] leading-relaxed text-slate-100">
            <code>{snippet || '参数不完整，暂时无法生成请求。'}</code>
          </pre>
        </div>
      </section>
    </div>
  );
}
