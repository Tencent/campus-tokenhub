import { NextResponse } from 'next/server';
import { memoizeWithTTL } from '@/lib/cache/memoize';
import { getCatalog } from '@/lib/gateway/catalog';

const HEALTH_PROBE_TTL_MS = 5000;

/** 探活：只看目录接口能不能打通，不代表上游模型可用。5 秒缓存，防止被刷出大量外呼。 */
const probeGateway = memoizeWithTTL(async () => {
  try {
    await getCatalog();
    return true;
  } catch {
    return false;
  }
}, HEALTH_PROBE_TTL_MS);

export async function GET(): Promise<NextResponse> {
  const gateway = await probeGateway();
  return NextResponse.json(
    { status: 'ok', gateway },
    { headers: { 'cache-control': 'no-store' } }
  );
}
