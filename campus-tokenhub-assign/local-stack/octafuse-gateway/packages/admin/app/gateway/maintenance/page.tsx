/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { redirect } from '@/ui/navigation';

// 维护模式已并入配置；保留旧地址以兼容书签与历史链接。
export default function LegacyMaintenancePage() {
	redirect('/gateway/config#config-panel-maintenance');
}
