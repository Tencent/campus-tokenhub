import type { Config } from 'tailwindcss';

/**
 * 设计 token 对齐 ardot 设计稿（file 748672675953760）。
 * - 页面底色 #F4F5F7，表面 #FFFFFF，描边 #E5E6EB
 * - 主色 #2557D6，深 #1E48B8，浅底 #EDF2FE
 * - 正文 #1D2129 / #4E5969，辅助 #86909C
 * - 圆角：卡片 10、控件与按钮 6
 *
 * 历史类名（cream / brand-orange / ink-*）保持不变，只换色值：
 * 全站已有大量组件引用这些键，改键名会牵连所有页面。
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: {
          DEFAULT: '#F4F5F7',
          100: '#EFF1F4',
          200: '#E5E6EB',
        },
        line: '#E5E6EB',
        brand: {
          /** 主色（沿用旧键名 brand-orange 以兼容存量类名） */
          orange: '#2557D6',
          'orange-dark': '#1E48B8',
          'orange-soft': '#EDF2FE',
          /** 浅底上的文字链接/标签，满足 4.5:1 */
          link: '#2557D6',
          /** 提示色，用于限时/风险类标签 */
          yellow: '#E8700F',
          'yellow-soft': '#FFF6EC',
        },
        ink: {
          900: '#1D2129',
          700: '#4E5969',
          600: '#4E5969',
          500: '#86909C',
          400: '#A9AEB8',
          300: '#C9CDD4',
        },
        success: '#17914F',
        danger: '#D93B2B',
      },
      borderRadius: {
        card: '10px',
        control: '6px',
      },
      boxShadow: {
        /** 设计稿卡片只有 1px 描边，投影仅用于弹窗与浮层 */
        card: '0 1px 2px rgba(29, 33, 41, 0.03)',
        'card-hover': '0 4px 12px -4px rgba(29, 33, 41, 0.12)',
        /** 主按钮不加彩色光晕，保持与设计稿一致的扁平感 */
        cta: '0 1px 2px rgba(37, 87, 214, 0.18)',
        /** 弹窗：0 8 24 -2 rgba(0,0,0,.1) */
        pop: '0 8px 24px -2px rgba(0, 0, 0, 0.1)',
      },
      fontFamily: {
        sans: [
          'Noto Sans SC',
          '-apple-system',
          'BlinkMacSystemFont',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
