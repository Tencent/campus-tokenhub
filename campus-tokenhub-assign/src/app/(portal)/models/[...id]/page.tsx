import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findModel, formatPricing, getCatalog } from '@/lib/gateway/catalog';
import { getPublicProxyBase } from '@/lib/config';
import { formatPointsPrice } from '@/lib/portal/points';
import { ModelSnippets } from '@/components/models/ModelSnippets';
import { ProxyBaseNotice } from '@/components/portal/ProxyBaseNotice';
import { buildPayload, PayloadError, type PlaygroundForm } from '@/lib/playground/payload';
import { renderCurl } from '@/lib/playground/snippets';

export const dynamic = 'force-dynamic';

const SUPPORTED = new Set(['chat', 'images.generations', 'embeddings']);

/** 操作标识面向开发者保留原样，标签用中文，和模型列表保持一致 */
const OPERATION_LABEL: Record<string, string> = {
  chat: '对话',
  responses: 'Responses',
  messages: 'Messages',
  'models.generate': '生成',
  'images.generations': '图像生成',
  'images.edits': '图像编辑',
  embeddings: '向量',
};

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function sampleForm(operation: string): PlaygroundForm {
  if (operation === 'images.generations') {
    return { prompt: '一只在图书馆看书的橘猫，暖色插画风格', n: 1 };
  }
  if (operation === 'embeddings') {
    return { input: '学校的 AI 平台怎么用？' };
  }
  return { messages: [{ role: 'user', content: '你好，请用一句话介绍你自己。' }] };
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2.5 text-sm last:border-0">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-900 tabular-nums">{value}</dd>
    </div>
  );
}

export default async function ModelDetailPage({
  params,
}: {
  params: Promise<{ id: string[] }>;
}) {
  const { id } = await params;
  // catch-all 路由：`deepseek/deepseek-flash` 这类带斜杠的模型 ID 会被拆成多段，拼回来才是完整 ID。
  // 各段已被 Next 解码过，二次 decodeURIComponent 会在 `%` 等非法序列上抛 URIError 变 500。
  const modelId = id.join('/');

  const snapshot = await getCatalog().catch(() => null);
  const model = snapshot ? findModel(snapshot.models, modelId) : null;
  if (!model) notFound();

  const pricing = formatPricing(model);
  const operations = [...new Set((model.inbound ?? []).map((item) => item.operation).filter(Boolean))] as string[];
  const operation = operations[0] ?? 'chat';
  const baseUrl = getPublicProxyBase();

  let snippet: { path: string; body: Record<string, unknown>; unsupported: boolean } | null = null;
  let snippetError: string | null = null;
  try {
    snippet = buildPayload({ model, operation, form: sampleForm(operation) });
  } catch (error) {
    snippetError = error instanceof PayloadError ? error.message : '示例生成失败';
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <Link
          href="/models"
          className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1 text-xs text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
        >
          ← 返回模型列表
        </Link>
        <h1 className="mt-3 text-[26px] font-semibold leading-9 tracking-tight text-ink-900">
          {model.display_name || model.id}
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-500">{model.id}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {operations.map((item) => (
            <span
              key={item}
              className="rounded-full bg-brand-orange-soft px-2.5 py-0.5 text-[11px] font-medium text-brand-link"
            >
              {OPERATION_LABEL[item] ?? item}
            </span>
          ))}
        </div>
      </header>

      <ProxyBaseNotice proxyBase={baseUrl} />

      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">能力参数</h2>
          <dl className="mt-2">
            <Row
              label="上下文长度"
              value={model.context_window ? `${formatNumber(model.context_window)} tokens` : null}
            />
            <Row
              label="最大输出"
              value={model.max_tokens ? `${formatNumber(model.max_tokens)} tokens` : null}
            />
            <Row label="输入模态" value={model.input_modalities?.join(' / ') || null} />
            <Row label="输出模态" value={model.output_modalities?.join(' / ') || null} />
            <Row label="厂商" value={model.vendor} />
            <Row label="可调试操作" value={operations.map((item) => OPERATION_LABEL[item] ?? item).join(' / ') || null} />
          </dl>
        </section>

        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">当前价格</h2>
          <dl className="mt-2">
            <Row
              label="输入"
              value={model.pricing_profile?.image ? null : `${formatPointsPrice(pricing.price.inputPerMillion)} 算力值 / 百万 tokens`}
            />
            <Row
              label="输出"
              value={model.pricing_profile?.image ? null : `${formatPointsPrice(pricing.price.outputPerMillion)} 算力值 / 百万 tokens`}
            />
            <Row
              label="缓存命中"
              value={
                pricing.price.cacheReadPerMillion === null
                  ? null
                  : `${formatPointsPrice(pricing.price.cacheReadPerMillion)} 算力值 / 百万 tokens`
              }
            />
            <Row
              label="按张计费"
              value={pricing.price.imagePrice === null ? null : `${formatPointsPrice(pricing.price.imagePrice)} 算力值 / 张`}
            />
            <Row label="时段" value={pricing.scheduleHint} />
            <Row label="限时折扣" value={pricing.providerNote} />
          </dl>
          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
            价格已含当前时段倍率。
          </p>
        </section>
      </div>

      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold text-ink-900">调用示例</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-500">
          {SUPPORTED.has(operation)
            ? '复制即可运行；把 $PORTAL_KEY 换成你自己的密钥。'
            : '该类型暂不支持在线调试，下面是等价的请求片段。'}
        </p>

        <div className="mt-4">
          {snippet ? (
            <ModelSnippets baseUrl={baseUrl} path={snippet.path} body={snippet.body} />
          ) : (
            <p className="text-sm text-rose-600">{snippetError ?? '示例生成失败'}</p>
          )}
        </div>

        {snippet?.unsupported && (
          <p className="mt-3 rounded-control bg-cream-100 px-3 py-2 text-xs leading-relaxed text-ink-600">
            该操作的请求体还包含上游私有字段，门户不生成半成品表单，建议直接在
            <Link
              href={`/playground?model=${encodeURIComponent(model.id)}`}
              className="mx-1 font-medium text-brand-link hover:underline"
            >
              调试台
            </Link>
            用「高级参数」补齐后再发。
          </p>
        )}

        {snippet && snippet.unsupported && (
          <pre className="scroll-x mt-3 rounded-card bg-ink-900 p-4 text-xs text-slate-100">
            <code>{renderCurl({ baseUrl, path: snippet.path, body: snippet.body })}</code>
          </pre>
        )}
      </section>
    </div>
  );
}
