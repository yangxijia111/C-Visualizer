// 基准测试专用配置：与常规测试隔离（npm test 不加载本文件）
// 运行：npm run bench
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.bench.ts'],
    testTimeout: 300000,
    // 暴露 global.gc，用于 heapUsed 前后差测量（vitest 5 顶层 execArgv）
    execArgv: ['--expose-gc'],
  },
});
