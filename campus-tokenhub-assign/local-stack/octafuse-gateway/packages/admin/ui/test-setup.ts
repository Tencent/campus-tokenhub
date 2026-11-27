/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * UI 测试环境初始化：注册 jest-dom matcher（toBeInTheDocument 等）到 Vitest 的 expect。
 * 只允许放全局测试基建，不要在此引入业务模块。
 */
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// 懒加载路由模块首次 transform 在并行跑满 8 个测试文件时可能超过 findBy* 的默认 1s，
// 会把“加载慢”误报成“元素找不到”。统一放宽等待预算（断言内容不变）。
configure({ asyncUtilTimeout: 5000 });
