import { describe, expect, it } from 'vitest';
import { isDangerousSvg } from '@/lib/config/logo';

function svg(source: string): Buffer {
  return Buffer.from(source, 'utf8');
}

describe('isDangerousSvg', () => {
  it('拦 script 与 foreignObject', () => {
    expect(isDangerousSvg(svg('<svg><script>alert(1)</script></svg>'))).toBe(true);
    expect(isDangerousSvg(svg('<svg><foreignObject><body/></foreignObject></svg>'))).toBe(true);
  });

  it('拦自闭合标签上的事件属性（/ 不是空白）', () => {
    expect(isDangerousSvg(svg('<svg/onload=alert(1)>'))).toBe(true);
    expect(isDangerousSvg(svg('<svg onmouseover = "alert(1)"></svg>'))).toBe(true);
  });

  it('拦脚本协议 href，包括数字实体编码', () => {
    expect(isDangerousSvg(svg('<svg><a href="javascript:alert(1)"/></svg>'))).toBe(true);
    expect(isDangerousSvg(svg('<svg><a xlink:href="javascript:alert(1)"/></svg>'))).toBe(true);
    expect(isDangerousSvg(svg('<svg><a href="&#106;avascript:alert(1)"/></svg>'))).toBe(true);
    expect(isDangerousSvg(svg('<svg><a href="&#x6a;avascript:alert(1)"/></svg>'))).toBe(true);
  });

  it('放行正常矢量图形', () => {
    expect(
      isDangerousSvg(svg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'))
    ).toBe(false);
    expect(isDangerousSvg(svg('<svg><use xlink:href="#icon-logo"/></svg>'))).toBe(false);
  });
});
