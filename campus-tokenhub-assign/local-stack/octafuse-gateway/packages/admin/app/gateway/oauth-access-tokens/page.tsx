/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { redirect } from '@/ui/navigation';

// OAuth 访问令牌已并入「MCP 服务」页；保留旧地址以免书签失效。
export default function LegacyOAuthAccessTokensPage() {
	redirect('/gateway/mcp#oauth-access-tokens');
}
