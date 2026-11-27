import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sessionTokensFromCookieHeader, verifyAnySession, type SessionPayload } from './session';
import { isSessionRevoked } from './revocation';
import { isPasswordSessionAllowed } from './local-admin';
import { refreshConfigOverlay } from '@/lib/config/overlay';

/** 仅在同一次服务端渲染中复用验签结果，不在请求或用户之间共享会话。 */
export const getCurrentSession = cache(async (): Promise<SessionPayload | null> => {
  // 逐个验签：浏览器里可能同时存在新旧两个同名 Cookie（同名不同 Path）
  const headerStore = await headers();
  const session = await verifyAnySession(
    sessionTokensFromCookieHeader(headerStore.get('cookie'))
  );
  if (!session) return null;
  // 已登出 / 被吊销的会话即使签名有效也不再放行
  if (await isSessionRevoked(session)) return null;
  // 引导期密码会话：运维把开关置 off 后立即失效，避免「关掉之后旧会话还能用」。
  // 强制重读配置：内存快照有 30 秒 TTL，多副本下刚改完开关时可能还是旧值。
  if (session.login_method === 'password') {
    await refreshConfigOverlay();
    if (!isPasswordSessionAllowed(session)) return null;
  }
  return session;
});

export async function requireCurrentSession(): Promise<SessionPayload> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  return session;
}
