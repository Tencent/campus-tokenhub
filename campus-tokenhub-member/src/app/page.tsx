import { redirect } from 'next/navigation';

// 成员站只有一个首页，不做服务端判定，静态跳转即可
export const dynamic = 'force-dynamic';

/**
 * 成员站的站点入口：直接落到 `/members`。
 * 未登录的情况由 middleware 拦到 /login 并带上 `next=/members`。
 */
export default async function HomePage(): Promise<never> {
  redirect('/members');
}
