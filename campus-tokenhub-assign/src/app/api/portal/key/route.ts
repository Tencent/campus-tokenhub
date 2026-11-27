import { NextResponse } from 'next/server';
import { jsonError, requireSession } from '@/lib/api/guard';
import { getActiveKey } from '@/lib/gateway/keys';

/**
 * 给在线调试台用：客户端页面加载后取自己的 Key 到内存。
 * 不进 SSR HTML、不进 localStorage，请求也只在同源同会话下可用。
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request);
    if (!session.octafuse_user_id) {
      return NextResponse.json({ error: '账号正在开通中', code: 'not_provisioned' }, { status: 409 });
    }

    const key = await getActiveKey(session.octafuse_user_id);
    if (!key) {
      return NextResponse.json({ error: '尚未创建密钥', code: 'no_key' }, { status: 404 });
    }

    return NextResponse.json(
      { key: key.key, key_id: key.id },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
