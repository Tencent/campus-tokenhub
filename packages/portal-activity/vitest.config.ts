import { defineConfig } from 'vitest/config';

/**
 * 共享活动记录包的测试配置。
 *
 * 只跑纯逻辑（schema 语句、路径规范化、写入编排、上报传输），
 * 不渲染组件：组件行为由两站的 SSR 回归用例覆盖。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
