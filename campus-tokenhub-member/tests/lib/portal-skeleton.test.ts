import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelGridSkeleton, PageSkeleton, SkeletonBlock, type PageSkeletonVariant } from '@/components/portal/Skeleton';

function renderPage(variant: PageSkeletonVariant): string {
  return renderToStaticMarkup(createElement(PageSkeleton, { variant }));
}

describe('门户加载反馈', () => {
  it('占位块不独立播放动画', () => {
    const html = renderToStaticMarkup(createElement(SkeletonBlock));
    expect(html).not.toContain('animate-pulse');
  });

  it('模型网格只在最外层声明动画区域', () => {
    const html = renderToStaticMarkup(createElement(ModelGridSkeleton));
    expect(html.match(/skeleton-region/g)).toHaveLength(1);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('animate-pulse');
  });

  it.each<[PageSkeletonVariant, string]>([
    ['overview', '我的算力'],
    ['models', '模型'],
    ['guide', '接入指南'],
  ])('%s 路由加载期间仍显示真实标题', (variant, title) => {
    const html = renderPage(variant);
    expect(html).toContain(`<h1 class="text-2xl font-semibold tracking-tight text-ink-900">${title}</h1>`);
    expect(html).toContain('aria-busy="true"');
  });

  it('playground 加载期间不渲染正文大标题（标题只来自顶栏）', () => {
    const html = renderPage('playground');
    expect(html).not.toContain('<h1');
    expect(html).toContain('aria-busy="true"');
  });

  it('指南加载布局保留静态步骤和后续卡片位置', () => {
    const html = renderPage('guide');
    expect(html).toContain('接入信息');
    expect(html).toContain('一键接入 WorkBuddy');
    expect(html).toContain('手动接入 WorkBuddy');
    expect(html).toContain('快速验证');
    expect(html).toContain('常见问题');
    expect(html.match(/<section/g)).toHaveLength(5);
  });
});
