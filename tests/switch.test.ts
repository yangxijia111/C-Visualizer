// switch 测试：匹配 / default / fall-through 穿透 / break
import { describe, expect, it } from 'vitest';
import { runSrc } from './helpers';

describe('switch 基础', () => {
  it('命中 case 执行对应语句', async () => {
    const r = await runSrc(`
      int main() {
        int x = 2;
        int result = 0;
        switch (x) {
          case 1: result = 10; break;
          case 2: result = 20; break;
          case 3: result = 30; break;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(20);
  });

  it('无匹配且无 default：跳过整个 switch', async () => {
    const r = await runSrc(`
      int main() {
        int x = 9;
        int result = 7;
        switch (x) {
          case 1: result = 10; break;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(7);
  });

  it('default 在末尾', async () => {
    const r = await runSrc(`
      int main() {
        int x = 99;
        int result = 0;
        switch (x) {
          case 1: result = 10; break;
          default: result = -1; break;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(-1);
  });

  it('default 在中间：无匹配时进入 default 并穿透', async () => {
    const r = await runSrc(`
      int main() {
        int x = 50;
        int result = 0;
        switch (x) {
          case 1: result = 10; break;
          default: result = 1;
          case 3: result = result + 100; break;
        }
        return 0;
      }
    `);
    // default: result=1，穿透到 case 3: result=101
    expect(r.finalVar('result')?.value).toBe(101);
  });

  it('char 判别式与 char case', async () => {
    const r = await runSrc(`
      int main() {
        char c = 'b';
        int result = 0;
        switch (c) {
          case 'a': result = 1; break;
          case 'b': result = 2; break;
          default: result = 0;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(2);
  });

  it('case 常量表达式：case 1+1', async () => {
    const r = await runSrc(`
      int main() {
        int x = 2;
        int result = 0;
        switch (x) {
          case 1 + 1: result = 42; break;
          default: result = 0;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(42);
  });
});

describe('fall-through 穿透（核心教学点）', () => {
  it('无 break 时穿透到下一个 case', async () => {
    const r = await runSrc(`
      int main() {
        int x = 1;
        int result = 0;
        switch (x) {
          case 1: result = result + 1;
          case 2: result = result + 10;
          case 3: result = result + 100;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(111);
  });

  it('穿透过程产生 fall-through 步骤', async () => {
    const r = await runSrc(`
      int main() {
        int x = 1;
        switch (x) {
          case 1: x = 11;
          case 2: x = 22;
          case 3: x = 33;
        }
        return 0;
      }
    `);
    const fallthroughs = r.steps.filter((s) => s.statementType === 'case-fallthrough');
    expect(fallthroughs.length).toBe(2);
    expect(fallthroughs[0].description).toContain('穿透');
  });

  it('case 2: case 3: 合并标签匹配', async () => {
    const r = await runSrc(`
      int main() {
        int x = 3;
        int result = 0;
        switch (x) {
          case 1:
          case 2:
            result = 100;
            break;
          case 3:
            result = 300;
            break;
        }
        return 0;
      }
    `);
    expect(r.finalVar('result')?.value).toBe(300);
  });

  it('break 阻止穿透', async () => {
    const r = await runSrc(`
      int main() {
        int x = 1;
        int result = 0;
        switch (x) {
          case 1: result = 1; break;
          case 2: result = 2; break;
        }
        return 0;
      }
    `);
    const fallthroughs = r.steps.filter((s) => s.statementType === 'case-fallthrough');
    expect(fallthroughs.length).toBe(0);
  });

  it('switch 步骤序列：判别式 → 匹配 → 语句', async () => {
    const r = await runSrc(`
      int main() {
        int x = 2;
        switch (x) {
          case 2: x = 20; break;
        }
        return 0;
      }
    `);
    const kinds = r.stepKinds();
    const discIdx = kinds.indexOf('switch-discriminant:discriminant');
    const matchIdx = kinds.indexOf('case-check:match');
    expect(discIdx).toBeGreaterThanOrEqual(0);
    expect(matchIdx).toBe(discIdx + 1);
    expect(r.steps[matchIdx].description).toContain('case 2');
  });
});
