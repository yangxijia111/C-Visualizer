// 差分测试：gcc / clang 可用时，语料程序的 stdout 必须与 C-Visualizer 一致
// 环境无编译器 → 整套优雅跳过，并输出 DIFFERENTIAL_COMPILER_UNAVAILABLE 标记
// （CI ubuntu-latest 自带 gcc，会实跑；本地 Windows 通常跳过）
import { describe, expect, it, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS } from './corpus';
import { compileOk, runSrc } from '../helpers';

function detectCompiler(): { cmd: string; brand: string } | null {
  for (const cmd of ['gcc', 'clang']) {
    const probe = spawnSync(cmd, ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (probe.status === 0) return { cmd, brand: cmd };
  }
  return null;
}

const CC = detectCompiler();

/** 用系统编译器编译并执行，返回 stdout（失败返回 null 与原因） */
function runWithCC(code: string, workdir: string, id: string): { stdout: string; error?: string } {
  const src = join(workdir, `${id}.c`);
  const exe = join(workdir, process.platform === 'win32' ? `${id}.exe` : id);
  writeFileSync(src, code);
  const build = spawnSync(CC!.cmd, ['-O0', '-o', exe, src], { timeout: 30000, encoding: 'utf8' });
  if (build.status !== 0) {
    return { stdout: '', error: `编译失败: ${(build.stderr || '').slice(0, 400)}` };
  }
  const run = spawnSync(exe, { timeout: 10000, encoding: 'utf8' });
  if (run.status !== 0 && run.status !== null) {
    return { stdout: run.stdout ?? '', error: `退出码 ${run.status}: ${(run.stderr || '').slice(0, 200)}` };
  }
  return { stdout: run.stdout ?? '', error: run.error ? String(run.error) : undefined };
}

describeRun();

function describeRun(): void {
  const suite = () => {
    let workdir = '';

    beforeAll(() => {
      workdir = mkdtempSync(join(tmpdir(), 'cvis-diff-'));
      return () => rmSync(workdir, { recursive: true, force: true });
    });

    for (const c of CORPUS) {
      it(`${c.id}（${c.focus}）与 ${CC?.brand ?? 'cc'} 输出一致`, async () => {
        // 前置：本引擎必须能编译且正常跑完（语料是 defined behavior）
        const r = await runSrc(c.code);
        expect(r.ok, `语料 ${c.id} 在 C-Visualizer 中应正常结束`).toBe(true);
        const cc = runWithCC(c.code, workdir, c.id);
        expect(cc.error, `gcc 执行异常: ${cc.error}`).toBeUndefined();
        expect(r.output).toBe(cc.stdout.replace(/\r\n/g, '\n'));
      });
    }

    it('语料全部通过编译（本引擎侧前置完整性）', async () => {
      for (const c of CORPUS) {
        await compileOk(c.code);
      }
    });
  };

  if (CC) {
    describe(`差分测试（${CC.brand} 可用，实跑对比）`, suite);
  } else {
    // 无法验证时显式记录，避免静默跳过被误认为通过
    console.warn('[DIFFERENTIAL_COMPILER_UNAVAILABLE] 本环境无 gcc/clang，差分测试跳过（CI ubuntu 会实跑）');
    describe.skip('差分测试（DIFFERENTIAL_COMPILER_UNAVAILABLE）', suite);
  }
}
