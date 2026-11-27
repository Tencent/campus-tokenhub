import { getModelIconSvg } from '@/lib/portal/model-icons';

/**
 * 模型品牌图标。
 *
 * SVG 来自 `@/lib/portal/model-icons` 的静态常量（与 learning-buddy-web 同一套图标），
 * 不是用户输入，因此可以直接内联；容器负责尺寸与颜色。
 */
export function ModelIcon({
  id,
  name,
  size = 'md',
}: {
  id: string;
  name: string;
  /** sm 用于列表行，md 用于卡片 */
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9';

  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center rounded-lg border border-line bg-white text-ink-900 [&_svg]:h-5 [&_svg]:w-5`}
      dangerouslySetInnerHTML={{ __html: getModelIconSvg(id, name) }}
    />
  );
}
