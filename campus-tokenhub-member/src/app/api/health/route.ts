import { NextResponse } from 'next/server';
import { isPortalDbConfigured } from '@/lib/db/portal-db';

/**
 * 探活：成员站的外部依赖只有门户数据库与腾讯云组织接口，
 * 这里只报「数据库是否已配置」，不做真实查询——探活接口被刷时不该产生 DB 连接。
 *
 * 与统一采买站（assign）的差异：那边会顺带探一次网关目录接口，成员站没有网关。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { status: 'ok', database: isPortalDbConfigured() },
    { headers: { 'cache-control': 'no-store' } }
  );
}
