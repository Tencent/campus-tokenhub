import Link from 'next/link';
import { Suspense } from 'react';
import { requireCurrentSession } from '@/lib/auth/current';
import { getPublicProxyBase } from '@/lib/config';
import { getCatalog } from '@/lib/gateway/catalog';
import { listKeys } from '@/lib/gateway/keys';
import type { GatewayKey } from '@/lib/gateway/types';
import { excludeStatus } from '@/lib/playground/allowlist';
import { PlaygroundClient } from '@/components/playground/PlaygroundClient';
import { ProxyBaseNotice } from '@/components/portal/ProxyBaseNotice';
import { PlaygroundGridSkeleton } from '@/components/portal/Skeleton';

export const dynamic = 'force-dynamic';

/**
 * 调试台没有独立入口，只能从「密钥」页某把 Key 点「调试」进来，URL 上带 key id。
 * 服务端只确认这把 Key 属于当前用户且仍然有效，**不下发明文**（明文只走 /api/portal/key），
 * 客户端挂载后再按需拉取到内存。
 */
async function resolveBoundKey(userId: string | null, keyId: string): Promise<GatewayKey | null> {
  if (!userId || !keyId) return null;
  try {
    const keys = await listKeys(userId);
    return keys.find((key) => key.id === keyId && key.status === 'active') ?? null;
  } catch {
    return null;
  }
}

/** 数据区：拉模型目录后再挂载调试台 */
async function PlaygroundSection({
  proxyBase,
  userId,
  keyId,
  modelId,
}: {
  proxyBase: string;
  userId: string | null;
  keyId: string;
  modelId: string;
}) {
  const [catalogResult, boundKey] = await Promise.allSettled([
    getCatalog(),
    resolveBoundKey(userId, keyId),
  ]);

  if (catalogResult.status === 'rejected') {
    return (
      <div className="rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-4 py-3 text-sm leading-6 text-danger">
        暂时无法获取模型目录，请稍后刷新。
      </div>
    );
  }

  const models = excludeStatus(catalogResult.value.models);
  const key = boundKey.status === 'fulfilled' ? boundKey.value : null;

  return (
    <PlaygroundClient
      models={models}
      proxyBase={proxyBase}
      initialKeyName={key?.name ?? null}
      initialModelId={modelId || null}
    />
  );
}

export default async function PlaygroundPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string | string[]; model?: string | string[] }>;
}) {
  const proxyBase = getPublicProxyBase();
  const session = await requireCurrentSession();
  const params = await searchParams;
  const keyId = typeof params.key === 'string' ? params.key : '';
  const modelId = typeof params.model === 'string' ? params.model : '';

  return (
    <div className="space-y-4">
      <ProxyBaseNotice proxyBase={proxyBase} />

      <header className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] leading-[21px] text-ink-500">
          {proxyBase ? (
            <>
              选模型、填参数、直接发请求。请求由浏览器持你的 Key 直连{' '}
              <code className="rounded bg-cream-100 px-1 py-0.5 font-mono text-[11px] text-ink-700">
                {proxyBase}
              </code>
              ，不经过门户。
            </>
          ) : (
            <>选模型、填参数、直接发请求。当前未配置网关地址，请求无法发出。</>
          )}
        </p>
        <Link
          href="/overview"
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-control border border-line bg-white px-3 text-xs text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
        >
          ← 返回我的算力
        </Link>
      </header>

      <Suspense fallback={<PlaygroundGridSkeleton />}>
        <PlaygroundSection
          proxyBase={proxyBase}
          userId={session.octafuse_user_id ?? null}
          keyId={keyId}
          modelId={modelId}
        />
      </Suspense>
    </div>
  );
}
