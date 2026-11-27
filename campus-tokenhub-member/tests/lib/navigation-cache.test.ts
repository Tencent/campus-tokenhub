import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('动态门户导航缓存策略', () => {
  it('普通访问和 FULL 预取均使用短缓存窗口', () => {
    const times = nextConfig.experimental?.staleTimes;
    expect(times?.dynamic).toBe(120);
    expect(times?.static).toBe(times?.dynamic);
  });
});
