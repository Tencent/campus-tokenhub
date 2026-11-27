import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next@15 只提供 eslintrc 格式配置，用 FlatCompat 桥接到 ESLint 9 flat config
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'coverage/**',
      'local-stack/**',
      'next-env.d.ts',
      '*.tsbuildinfo',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx', 'tests/helpers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // 用例里常用 `const { X, ...rest } = base` 故意剔除某字段来验证缺失校验
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
];

export default config;
