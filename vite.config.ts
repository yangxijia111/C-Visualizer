// Vite 配置：React 插件 + GitHub Pages 子路径 base
// base 仅在 `--mode pages` 构建时生效（对应 npm run build:pages / Pages 部署），
// 本地 dev、普通 build、preview 保持根路径，体验不变
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { PAGES_BASE } from './src/site-config';

export default defineConfig(({ mode }) => ({
  base: mode === 'pages' ? PAGES_BASE : '/',
  plugins: [react()],
}));
