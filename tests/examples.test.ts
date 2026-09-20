// 示例库集成测试：每个示例必须可编译并正常执行完成
import { describe, expect, it } from 'vitest';
import { compile, runProgram } from '../src/core/run';
import { EXAMPLES } from '../src/examples';
import './helpers'; // 安装 Node 端 wasm 加载器

describe('示例库完整性', () => {
  it('示例数量 ≥ 19（任务书要求）', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(19);
  });

  it('每个示例结构完整', () => {
    for (const ex of EXAMPLES) {
      expect(ex.id, ex.id).toBeTruthy();
      expect(ex.title, ex.id).toBeTruthy();
      expect(ex.tags.length, ex.id).toBeGreaterThan(0);
      expect(ex.description, ex.id).toBeTruthy();
      expect(ex.code.length, ex.id).toBeGreaterThan(10);
    }
  });

  for (const ex of EXAMPLES) {
    it(`示例「${ex.title}」编译并正常完成`, async () => {
      const compiled = await compile(ex.code);
      if (!compiled.ok) {
        const detail = compiled.errors.map((e) => `[${e.code}] ${e.line}:${e.column} ${e.message}`).join('; ');
        throw new Error(`示例 ${ex.id} 编译失败：${detail}`);
      }
      const result = runProgram(compiled.program, ex.code);
      const last = result.steps[result.steps.length - 1];
      if (last.status !== 'program-end') {
        throw new Error(`示例 ${ex.id} 未正常结束：${last.status} @ 第${last.line}行 — ${last.description}`);
      }
      expect(result.steps.length).toBeGreaterThan(2);
    }, 20000);
  }
});
