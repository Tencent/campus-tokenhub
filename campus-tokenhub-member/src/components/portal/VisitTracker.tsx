'use client';

/**
 * 页面访问上报组件（转发自共享包）。
 *
 * 单独留一层转发而不是让 layout 直接引包：`'use client'` 边界必须落在
 * 门户自己的文件上，Next 才能稳定地把包内实现判成客户端组件。
 */
export { VisitTracker } from '@campus/portal-activity';
