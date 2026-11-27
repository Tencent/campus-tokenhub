import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'MaaS工作台',
  description: '登录后自助领取 API Key，查看可用模型与用量',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
