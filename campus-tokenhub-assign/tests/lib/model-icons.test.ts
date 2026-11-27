import { describe, expect, it } from 'vitest';
import { getModelIconSvg } from '@/lib/portal/model-icons';

/** 断言图标来自哪一支：按各品牌 SVG 里的特征片段判断 */
function iconKind(svg: string): string {
  if (svg.includes('#3964FE')) return 'deepseek';
  if (svg.includes('#B3DDF2')) return 'hunyuan';
  if (svg.includes('#007AFF')) return 'kimi';
  if (svg.includes('#D4367A')) return 'minimax';
  if (svg.includes('lb-dm-g0')) return 'default';
  if (svg.includes('lb-gemini-g0')) return 'gemini';
  if (svg.includes('lb-ds-clip')) return 'deepseek';
  if (svg.includes('M6.8092 0L5.5837 1.6613')) return 'glm';
  return 'unknown';
}

describe('getModelIconSvg', () => {
	it('按模型 id 命中品牌图标', () => {
		expect(iconKind(getModelIconSvg('deepseek-v4.1-flash'))).toBe('deepseek');
		expect(iconKind(getModelIconSvg('deepseek/deepseek-flash'))).toBe('deepseek');
		expect(iconKind(getModelIconSvg('glm-5.2'))).toBe('glm');
		expect(iconKind(getModelIconSvg('kimi-k3'))).toBe('kimi');
		expect(iconKind(getModelIconSvg('minimax-m3'))).toBe('minimax');
	});

	it('混元的 hy3 / hy4 / hy- 前缀都走混元图标', () => {
		for (const id of ['hy3', 'hy4', 'hy-vision-2.0-instruct', 'hunyuan-turbos-vision-video-20250728']) {
			expect(iconKind(getModelIconSvg(id))).toBe('hunyuan');
		}
	});

	it('未收录厂商回退默认图标，不抛错', () => {
		for (const id of ['kling-image-v3', 'seedream-image-v5.0-flash', 'mimo-v2.6-pro', 'kinfra-text-embedding-4b']) {
			expect(iconKind(getModelIconSvg(id))).toBe('default');
		}
	});

	it('展示名也参与匹配（id 认不出时）', () => {
		expect(iconKind(getModelIconSvg('model-x', 'DeepSeek V4.1 Flash'))).toBe('deepseek');
	});

	it('空 id 走 Auto 图标', () => {
		const svg = getModelIconSvg('');
		expect(svg).toContain('<svg');
		expect(svg).not.toContain('#3964FE');
	});
});
