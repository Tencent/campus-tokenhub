/**
 * Local OpenNext preview 需要 `packages/admin/.dev.vars`（gitignore）提供应急账密。
 * 生产默认关闭账密登录（门户 SSO + 集成密钥），这里只为本地 preview 显式打开
 * `ADMIN_PASSWORD_LOGIN=on`，避免起服务后无法登录。
 *
 * 不会覆盖已有文件；生产请用 Worker Secret，勿依赖此默认值。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, '..');
const target = path.join(pkgRoot, '.dev.vars');

const DEFAULT_CONTENTS = `# Auto-created for local OpenNext preview (gitignored). Do not use in production.
# Cloudflare runtime uses D1 via wrangler binding — do not set DATABASE_URL here.
# Local-only emergency password login; production keeps ADMIN_PASSWORD_LOGIN unset.
ADMIN_USERNAME=admin
ADMIN_PASSWORD=local-preview-only-9f2c4b7e
ADMIN_PASSWORD_LOGIN=on
`;

if (fs.existsSync(target)) {
	process.exit(0);
}

try {
	fs.writeFileSync(target, DEFAULT_CONTENTS, { encoding: 'utf8', flag: 'wx' });
	console.log(
		'[ensure-dev-vars] created packages/admin/.dev.vars — local-only emergency password login enabled',
	);
} catch (e) {
	if (e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST') {
		process.exit(0);
	}
	console.error('[ensure-dev-vars] failed to create .dev.vars', e);
	process.exit(1);
}
