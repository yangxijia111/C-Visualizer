// tree-sitter 解析器加载：双端（浏览器 / Node）依赖注入
// 详见 docs/PARSER_DESIGN.md §1.3、docs/ARCHITECTURE.md「双端加载」

import { Parser, Language } from 'web-tree-sitter';

export type WasmInput = string | URL | Uint8Array;

export interface CstSources {
  /** 运行时 wasm（浏览器需要传打包后 URL；Node 环境留空使用默认定位） */
  runtime?: WasmInput;
  /** 语法 wasm（tree-sitter-c.wasm 的路径或字节） */
  grammar: WasmInput;
}

let loader: (() => Promise<CstSources>) | null = null;
let parserPromise: Promise<Parser> | null = null;

/** 注入 wasm 来源（应用入口 / 测试环境各自调用一次） */
export function setCstSourcesLoader(l: () => Promise<CstSources>): void {
  loader = l;
  parserPromise = null;
}

/** 获取已初始化的解析器（异步单例） */
export async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    if (!loader) throw new Error('CST 加载器未初始化：请先调用 setCstSourcesLoader');
    parserPromise = (async () => {
      const sources = await loader!();
      if (sources.runtime) {
        const runtimeUrl =
          typeof sources.runtime === 'string' ? sources.runtime : String(sources.runtime);
        await Parser.init({ locateFile: () => runtimeUrl });
      } else {
        await Parser.init();
      }
      const language = await Language.load(sources.grammar);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}
