// 中文教学说明文案：确定性模板生成（无 AI、无随机）
// 详见 docs/VISUALIZATION_SPEC.md §7
import type { RuntimeValue } from './values';
import { valueToDisplay } from './values';
import type { VarDeclarator } from './ast';
import { isArray } from './types';

/** 变量声明说明（支持多声明符） */
export function descVarDecl(vars: VarDeclarator[], values: (RuntimeValue | null)[]): string {
  const parts = vars.map((v, i) => {
    const val = values[i];
    if (isArray(v.varType)) {
      const initialized = v.initList && v.initList.length > 0;
      return initialized
        ? `数组 ${v.name}[${v.varType.length}] 已初始化`
        : `数组 ${v.name}[${v.varType.length}]（元素全为 0）`;
    }
    if (val === null) return `变量 ${v.name}（${v.varType}，未初始化）`;
    return `${v.name} = ${valueToDisplay(val)}`;
  });
  if (vars.length === 1) {
    const v = vars[0];
    const val = values[0];
    if (isArray(v.varType)) {
      return v.initList && v.initList.length > 0
        ? `声明数组 ${v.name}[${v.varType.length}]，并初始化元素。`
        : `声明数组 ${v.name}[${v.varType.length}]，所有元素初始化为 0。`;
    }
    if (val === null) return `声明变量 ${v.name}（${v.varType}），暂未初始化。`;
    return `声明变量 ${v.name}（${v.varType}），并初始化为 ${valueToDisplay(val)}。`;
  }
  return `声明变量：${parts.join('，')}。`;
}

/** 赋值 */
export function descAssign(targetText: string, value: RuntimeValue): string {
  return `将 ${valueToDisplay(value)} 赋给 ${targetText}。`;
}

/** 自增自减 */
export function descIncDec(op: string, isPrefix: boolean, targetText: string, oldV: RuntimeValue, newV: RuntimeValue): string {
  const name = op === '++' ? '自增' : '自减';
  const exprText = isPrefix ? `${op}${targetText}` : `${targetText}${op}`;
  return `执行 ${exprText}（${isPrefix ? '前置' : '后置'}${name}）：${targetText} 从 ${valueToDisplay(oldV)} 变为 ${valueToDisplay(newV)}。`;
}

/** if 条件求值 */
export function descIfCondition(condText: string, v: RuntimeValue, taken: boolean): string {
  const verdict = taken ? '条件成立' : '条件不成立';
  return `判断 ${condText}：结果为 ${valueToDisplay(v)}（${v.value !== 0 ? '非 0 为真' : '0 为假'}），${verdict}。`;
}

/** if 分支走向 */
export function descIfBranch(taken: boolean, targetLine?: number): string {
  if (taken) return `条件成立，进入 if 分支。`;
  return targetLine !== undefined
    ? `条件不成立，跳过 if 分支，转到第 ${targetLine} 行继续。`
    : `条件不成立，跳过 if 分支。`;
}

/** 表达式语句（非赋值） */
export function descExprStmt(text: string, v: RuntimeValue): string {
  return `计算表达式 ${text}，结果为 ${valueToDisplay(v)}。`;
}

/** 短路求值 */
export function descShortCircuit(op: '&&' | '||', leftText: string, leftV: RuntimeValue, rightText: string): string {
  if (op === '&&') {
    return `&& 左侧 ${leftText} 为 ${valueToDisplay(leftV)}（假），根据短路规则，右侧 ${rightText} 不会执行，整个表达式结果为 0。`;
  }
  return `|| 左侧 ${leftText} 为 ${valueToDisplay(leftV)}（真），根据短路规则，右侧 ${rightText} 不会执行，整个表达式结果为 1。`;
}

/** 运行时错误 */
export function descRuntimeError(_code: string, message: string): string {
  return `发生错误：${message}`;
}

/** 程序结束 */
export function descProgramEnd(returnValue: RuntimeValue | null): string {
  if (returnValue === null) return 'main 函数执行完毕，程序结束。';
  return `main 函数返回 ${valueToDisplay(returnValue)}，程序结束。`;
}

/** 步数上限 */
export function descStepLimit(maxSteps: number): string {
  return `已执行 ${maxSteps} 步仍未结束，程序可能存在无限循环，已自动停止。请检查循环条件是否能变为假。`;
}

/** 墙钟超时 */
export function descTimeLimit(): string {
  return '执行时间过长，已自动停止（可能存在无限循环或超大计算量）。';
}

