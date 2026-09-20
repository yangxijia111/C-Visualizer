// 测试工具：Node 环境下的 wasm 加载 + 常用断言辅助
import { createRequire } from 'node:module';
import { setCstSourcesLoader } from '../src/core/cst';
import { compile } from '../src/core/run';
import type { Program } from '../src/core/ast';
import type { CompileError } from '../src/core/errors';

const require = createRequire(import.meta.url);
setCstSourcesLoader(async () => ({ grammar: require.resolve('tree-sitter-c/tree-sitter-c.wasm') }));

/** 编译并期望成功，失败时输出错误详情 */
export async function compileOk(src: string): Promise<Program> {
  const r = await compile(src);
  if (!r.ok) {
    const detail = r.errors.map((e) => `  [${e.code}] 第${e.line}行第${e.column}列：${e.message}${e.hint ? `（${e.hint}）` : ''}`).join('\n');
    throw new Error(`编译应当成功但失败：\n${detail}\n源码：\n${src}`);
  }
  return r.program;
}

/** 编译并期望失败，返回错误列表 */
export async function compileErr(src: string): Promise<CompileError[]> {
  const r = await compile(src);
  if (r.ok) throw new Error(`编译应当失败但成功。\n源码：\n${src}`);
  return r.errors;
}

/** 编译并期望恰好一条指定错误码的错误 */
export async function expectError(src: string, code: CompileError['code'], messagePart?: string): Promise<CompileError> {
  const errors = await compileErr(src);
  const found = errors.find((e) => e.code === code && (!messagePart || e.message.includes(messagePart)));
  if (!found) {
    throw new Error(`期望错误 ${code}${messagePart ? `（含「${messagePart}」）` : ''}，实际：${JSON.stringify(errors, null, 2)}\n源码：\n${src}`);
  }
  return found;
}

// ============ 解释器测试工具 ============

import { runProgram } from '../src/core/run';
import type { RunResult, ExecutionStep } from '../src/core/steps';
import type { RuntimeValue } from '../src/core/values';

export interface RunOutcome {
  result: RunResult;
  ok: boolean;
  steps: ExecutionStep[];
  output: string;
  status: RunResult['status'];
  /** 某步之后（默认最后一步）某变量的值 */
  varAt(stepIdx: number | 'final', name: string): RuntimeValue | undefined;
  /** 最终值 */
  finalVar(name: string): RuntimeValue | undefined;
  /** 逐步 statementType(+phase) 序列 */
  stepKinds(): string[];
  /** 全部说明文案 */
  descriptions(): string[];
  /** 全部求值轨迹（扁平） */
  traces(): { text: string; value?: number; skip?: string }[];
  /** 错误码（若最后一步是 runtime-error） */
  errorCode(): string | undefined;
}

export async function runSrc(src: string, opts?: { maxSteps?: number }): Promise<RunOutcome> {
  const compiled = await compile(src);
  if (!compiled.ok) {
    const detail = compiled.errors.map((e) => `[${e.code}] ${e.line}:${e.column} ${e.message}`).join('; ');
    throw new Error(`测试程序编译失败：${detail}\n源码：\n${src}`);
  }
  const result = runProgram(compiled.program, src, opts);
  const steps = result.steps;
  const lookup = (stepIdx: number | 'final', name: string): RuntimeValue | undefined => {
    const snap = stepIdx === 'final'
      ? steps[steps.length - 1]?.snapshot
      : steps[stepIdx]?.snapshot;
    if (!snap) return undefined;
    for (const scope of snap.scopes) {
      const v = scope.vars.find((x) => x.name === name);
      if (v && v.address !== null) {
        const cell = snap.cells[v.address];
        if (!cell || cell.value === null) return undefined;
        return { type: cell.type, value: cell.value, pointee: cell.pointee };
      }
    }
    return undefined;
  };
  return {
    result,
    ok: steps.length > 0 && steps[steps.length - 1].status === 'program-end',
    steps,
    output: result.output,
    status: result.status,
    varAt: lookup,
    finalVar: (name: string) => lookup('final', name),
    stepKinds: () => steps.map((s) => (s.phase ? `${s.statementType}:${s.phase}` : s.statementType)),
    descriptions: () => steps.map((s) => s.description),
    traces: () => steps.flatMap((s) => (s.evalTrace ?? []).map((t) => t.kind === 'eval'
      ? { text: t.text, value: t.value.value }
      : { text: t.text, skip: t.reason })),
    errorCode: () => {
      const last = steps[steps.length - 1];
      return last?.status === 'runtime-error' ? last.errorCode : undefined;
    },
  };
}
