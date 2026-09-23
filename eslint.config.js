import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node 环境脚本（benchmark / 浏览器 CDP 冒烟等）
    files: ['scripts/**/*.mjs', '*.config.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // 中文注释/文案场景下的规则微调
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: 'allExceptWhileTrue' }],
    },
  },
);
