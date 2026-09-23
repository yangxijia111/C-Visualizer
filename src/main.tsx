import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// v1.2 起 wasm 解析器全部在 Web Worker 内加载（src/worker/runtime.worker.ts 自行安装
// cst-web 加载器）；主线程不再引入 web-tree-sitter / tree-sitter-c，实现 bundle 拆分

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
