// 浏览器端的 wasm 加载（Vite ?url 导入，构建时打包为资源）
import runtimeWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import grammarWasmUrl from 'tree-sitter-c/tree-sitter-c.wasm?url';
import { setCstSourcesLoader } from '../core/cst';

export function installWebCstLoader(): void {
  setCstSourcesLoader(async () => ({
    runtime: runtimeWasmUrl,
    grammar: grammarWasmUrl,
  }));
}
