import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/current';
import { canAccessSetup } from '@/lib/onboarding/access';
import { isOnboardingCompleted } from '@/lib/onboarding/state';

// 是否已完成初始化取决于网关状态，必须在请求时判断，不能在构建时预渲染成静态跳转
export const dynamic = 'force-dynamic';

/**
 * 首页没有内容：初始化未完成且当前身份能进初始化页时先去 `/setup`，否则落到 `/overview`。
 * 未登录的情况由 middleware 拦到 /login，这里不重复处理。
 */
export default async function HomePage(): Promise<never> {
  const session = await getCurrentSession();

  // 理论上到不了：middleware 会把未登录请求拦到 /login
  if (!session) redirect('/overview');

  const [completed, canSetup] = await Promise.all([
    isOnboardingCompleted(),
    canAccessSetup(session),
  ]);

  redirect(!completed && canSetup ? '/setup' : '/overview');
}
