import Link from 'next/link';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { getConfig, getPublicProxyBase } from '@/lib/config';
import { loadChatModels } from '@/lib/guide/chat-models';
import { appPath } from '@/lib/paths';
import { GuideClient } from '@/components/guide/GuideClient';
import { ProxyBaseNotice } from '@/components/portal/ProxyBaseNotice';
import { GuideInfoSkeleton } from '@/components/portal/Skeleton';

export const dynamic = 'force-dynamic';

/**
 * 门户对外地址（含部署前缀），用于拼「方式一」命令里的脚本下载 URL。
 * 优先用配置里的 PUBLIC_BASE_URL；没配时按请求头兜底，避免命令里出现相对路径。
 *
 * 注意 `PUBLIC_BASE_URL` 通常只配到域名（当前双站部署就是 `http://host:8088`），而门户
 * 挂在 `basePath` 下。直接用它会拼出 `http://host:8088/api/portal/workbuddy/script`，
 * nginx 在根路径上没有这条路由 → 命令执行时报 404。所以这里统一取 origin 再补一次
 * `appPath('/')`（与 `portalUrl()` 同口径），保证前缀恰好出现一次。
 */
async function resolvePortalBaseUrl(): Promise<string> {
  try {
    const configured = getConfig().portal.publicBaseUrl.trim();
    if (configured) {
      try {
        return `${new URL(configured).origin}${appPath('/')}`.replace(/\/+$/, '');
      } catch {
        // 配置非法由 instrumentation 负责让进程退出，这里只做原样兜底
        return configured.replace(/\/+$/, '');
      }
    }
  } catch {
    // 配置非法由 instrumentation 负责让进程退出，这里只做兜底
  }

  const headerList = await headers();
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host');
  if (!host) return '';
  const proto = headerList.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}${appPath('/')}`.replace(/\/+$/, '');
}

/** 只有这一段依赖网关目录（模型 ID 下拉），外壳先渲染 */
async function GuideDataSection({ proxyBase, portalBaseUrl }: { proxyBase: string; portalBaseUrl: string }) {
  const models = await loadChatModels();

  return <GuideClient proxyBase={proxyBase} models={models} portalBaseUrl={portalBaseUrl} />;
}

export default async function GuidePage() {
  const proxyBase = getPublicProxyBase();
  const portalBaseUrl = await resolvePortalBaseUrl();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <p className="text-sm leading-relaxed text-ink-500">
        按下列接入信息完成配置，即可在 WorkBuddy、Cherry Studio 或自有代码中调用学校提供的模型服务。
      </p>

      <ProxyBaseNotice proxyBase={proxyBase} />

      <Suspense fallback={<GuideInfoSkeleton />}>
        <GuideDataSection proxyBase={proxyBase} portalBaseUrl={portalBaseUrl} />
      </Suspense>

      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <h2 className="text-sm font-semibold text-ink-900">常见问题</h2>
        <dl className="mt-3 space-y-4 text-sm">
          <div>
            <dt className="font-medium text-ink-900">测试连接失败，提示「无法连接到模型服务」</dt>
            <dd className="mt-1 text-xs leading-relaxed text-ink-600">
              常见原因为接口地址多写了一层。多数客户端会在地址后自动补 /chat/completions，因此填写至 /v1
              为止即可；若填写 …/v1/chat/completions，最终会拼接为 …/chat/completions/chat/completions 并返回 404。
              使用 curl 可正常调用，说明 Key 与网络均无问题。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink-900">提示「模型不存在」</dt>
            <dd className="mt-1 text-xs leading-relaxed text-ink-600">
              通常为模型 ID 不一致。请从本页复制模型 ID，勿添加前缀或后缀，也不要自行改名。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink-900">提示「该模型当前没有可用路由」</dt>
            <dd className="mt-1 text-xs leading-relaxed text-ink-600">
              该模型可能临时下架或正在调整，请改用其他模型；若持续出现，请将发生时间告知管理员。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink-900">提示「额度已用完」</dt>
            <dd className="mt-1 text-xs leading-relaxed text-ink-600">
              本期额度用尽后将无法继续调用，请待额度重置或联系管理员调整。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink-900">API Key 是否可以共享给他人</dt>
            <dd className="mt-1 text-xs leading-relaxed text-ink-600">
              不可以。用量与额度按个人统计，转交他人使用将被停用。
            </dd>
          </div>
          <div>
            <dt className="font-medium text-ink-900">如何查看单次调用的费用</dt>
            <dd className="mt-1 text-xs leading-relaxed text-ink-600">
              可在
              <Link href="/dashboard" className="mx-1 font-medium text-brand-link hover:underline">
                数据看板
              </Link>
              查看最近的调用明细与费用；额度进度见
              <Link href="/overview" className="mx-1 font-medium text-brand-link hover:underline">
                我的算力
              </Link>
              。
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
