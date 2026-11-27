/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * D7：本次迁移后管理台只以 Docker/Node 为受支持交付路径。
 *
 * UI 由 Vite 产物（`ui-dist`）+ 自定义 Node 入口（8789）提供，`/assets/**` 与
 * `/ui-version.json` 只有该入口会服务。Cloudflare/OpenNext 的 build/preview/deploy
 * 入口保留可识别，但在这里直接失败并给出 Node 替代命令，避免把旧 UI 或半迁移产物
 * 静默发布出去（不改 proxy 的 Cloudflare 支持）。
 */
const command = process.argv[2] ?? 'this command';

console.error(
	[
		`[admin] "${command}" is not a supported delivery path for the admin console.`,
		'',
		'After the Node-only migration the admin UI is built by Vite and served by the',
		'custom Node entry on port 8789. The Cloudflare/OpenNext runtime does not serve',
		'/assets/** or /ui-version.json, so deploying it would silently ship an outdated',
		'or broken console.',
		'',
		'Use one of:',
		'  npm run dev -w @octafuse/admin            # Next dev server (API + legacy pages)',
		'  npm run dev:node -w @octafuse/admin       # Node entry with a built UI on :8789',
		'  npm run build:docker -w @octafuse/admin   # production UI + Next + Node bundle',
		'  docker build -f Dockerfile.admin -t octafuse-admin:latest .',
		'',
		'The proxy workspace keeps its Cloudflare support; only the admin console moved.',
	].join('\n'),
);
process.exit(1);
