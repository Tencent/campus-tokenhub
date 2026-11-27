import type { ReactNode } from 'react';

/** 只给页面内容添加短淡入，导航栏与顶栏保持挂载。 */
export default function PortalTemplate({ children }: { children: ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
