/**
 * 把 docs/tokenhub-architecture.html 导出成图片。
 *
 *   node scripts/export-architecture-shots.mjs
 *
 * 产出（都在 docs/ 下，2x 像素密度）：
 *   tokenhub-architecture.png                        整页长图
 *   tokenhub-architecture-01-overview.png            图 01 平台整体架构（README 顶部引用）
 *   tokenhub-architecture-02-first-use.png           图 02 学生 / 教师第一次使用
 *   tokenhub-architecture-03-call-flow.png           图 03 一次模型调用的过程
 *   tokenhub-architecture-04-provider-onboarding.png 图 04 管理员接入一家模型服务
 *
 * 依赖 playwright（不在 package.json 里，按需安装，避免给运行时增加依赖）：
 *   npm i -D playwright && npx playwright install chromium
 * 本机装有 Chrome 时脚本会优先用 chrome，没有则回落到 playwright 自带的 chromium。
 *
 * 改了 HTML 之后重跑一次即可，README 引用的文件名保持不变。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SOURCE = path.join(DOCS, 'tokenhub-architecture.html');

/** 与 HTML 里 .fig 的顺序一一对应；改名会同时影响 README 的引用 */
const FIG_NAMES = [
  '01-overview',
  '02-first-use',
  '03-call-flow',
  '04-provider-onboarding',
];

const browser = await chromium
  .launch({ channel: 'chrome' })
  .catch(() => chromium.launch());

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 2,
  });

  await page.goto(`file://${SOURCE}`, { waitUntil: 'load' });
  // 等中文字体就绪，否则截图里可能出现回退字形
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);

  await page.screenshot({
    path: path.join(DOCS, 'tokenhub-architecture.png'),
    fullPage: true,
  });

  const figs = page.locator('.fig');
  const count = await figs.count();
  if (count !== FIG_NAMES.length) {
    console.warn(
      `⚠️  HTML 里有 ${count} 张图，但脚本只登记了 ${FIG_NAMES.length} 个文件名，请同步 FIG_NAMES`
    );
  }

  for (let i = 0; i < count; i++) {
    const name = FIG_NAMES[i] ?? String(i + 1).padStart(2, '0');
    await figs.nth(i).screenshot({
      path: path.join(DOCS, `tokenhub-architecture-${name}.png`),
    });
  }

  console.log(`已导出 ${count} 张分图 + 1 张整页长图 → docs/`);
} finally {
  await browser.close();
}
