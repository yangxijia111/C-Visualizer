// 中文教学说明文案：确定性模板生成（无 AI、无随机）
// 详见 docs/VISUALIZATION_SPEC.md §7
import type { RuntimeValue } from './values';
import { valueToDisplay } from './values';
import type { VarDeclarator } from './ast';
import { isArray } from './types';

/** 数组声明的初始化状态：初始化列表 / 零初始化（静态存储期）/ 未初始化（自动存储期） */
export type ArrayInitStatus = 'list' | 'zero' | 'uninit';

/** 变量声明说明（支持多声明符；数组展示由初始化策略决定） */
export function descVarDecl(vars: VarDeclarator[], values: (RuntimeValue | null)[], arrayStatus?: ArrayInitStatus[]): string {
  const statusOf = (idx: number): ArrayInitStatus => arrayStatus?.[idx] ?? (vars[idx].initList ? 'list' : 'zero');
  const parts = vars.map((v, i) => {
    const val = values[i];
    if (isArray(v.varType)) {
      if (statusOf(i) === 'list') return `数组 ${v.name}[${v.varType.length}] 已初始化`;
      if (statusOf(i) === 'zero') return `数组 ${v.name}[${v.varType.length}]（元素全为 0）`;
      return `数组 ${v.name}[${v.varType.length}]（元素未初始化）`;
    }
    if (val === null) return `变量 ${v.name}（${v.varType}，未初始化）`;
    return `${v.name} = ${valueToDisplay(val)}`;
  });
  if (vars.length === 1) {
    const v = vars[0];
    const val = values[0];
    if (isArray(v.varType)) {
      const st = statusOf(0);
      if (st === 'list') return `声明数组 ${v.name}[${v.varType.length}]，并初始化元素。`;
      if (st === 'zero') return `声明数组 ${v.name}[${v.varType.length}]，所有元素初始化为 0（全局变量）。`;
      return `声明数组 ${v.name}[${v.varType.length}]，元素未初始化（读取会报错）。`;
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

/** 用户取消（v1.2） */
export function descCancelled(): string {
  return '已停止执行（用户取消）。已生成的步骤仍可查看。';
}


// ============ 控制流（Phase 4） ============

/** 循环条件判断 */
export function descLoopCheck(loopType: 'while' | 'do-while' | 'for', condText: string, v: RuntimeValue, entered: boolean): string {
  const name = loopType === 'while' ? 'while' : loopType === 'do-while' ? 'do-while' : 'for';
  const act = entered
    ? (loopType === 'do-while' ? '条件成立，继续下一轮循环' : '条件成立，进入循环体')
    : `条件不成立，退出 ${name} 循环`;
  return `判断 ${name} 循环条件 ${condText}：结果为 ${valueToDisplay(v)}（${v.value !== 0 ? '真' : '假'}），${act}。`;
}

/** for 的 init / update */
export function descForInit(): string {
  return '执行 for 循环的初始化部分（只执行一次）。';
}

export function descForUpdate(text: string, v: RuntimeValue): string {
  return `执行 for 循环的更新表达式 ${text}，当前值为 ${valueToDisplay(v)}，随后回到条件判断。`;
}

/** break / continue */
export function descBreak(from: 'loop' | 'switch', loopType?: string): string {
  if (from === 'switch') return '执行 break：跳出 switch 语句。';
  return `执行 break：跳出${loopType ? ` ${loopType} ` : ''}循环。`;
}

export function descContinue(loopType: string, forUpdateNext: boolean): string {
  return forUpdateNext
    ? `执行 continue：跳过本轮循环体剩余部分，转到 ${loopType} 的更新表达式。`
    : `执行 continue：跳过本轮循环体剩余部分，回到 ${loopType} 的条件判断。`;
}

/** switch */
export function descSwitchDisc(text: string, v: RuntimeValue): string {
  return `计算 switch 表达式 ${text}，结果为 ${valueToDisplay(v)}，开始匹配 case。`;
}

export function descCaseMatch(caseText: string | null, discValue: RuntimeValue, matched: boolean): string {
  if (caseText === null) return `switch 表达式为 ${valueToDisplay(discValue)}，没有匹配任何 case，也没有 default，跳过整个 switch。`;
  return `switch 表达式结果为 ${valueToDisplay(discValue)}，${matched ? `进入 ${caseText}` : `没有匹配的 case，进入 ${caseText}`}。`;
}

export function descFallThrough(fromCase: string, toCase: string): string {
  return `${fromCase} 的语句执行完毕且没有 break，发生穿透（fall-through），继续执行 ${toCase} 的语句。`;
}

/** goto */
export function descGoto(label: string, _fromLine: number, toLine: number): string {
  return `执行 goto ${label}：程序跳转到标签 ${label}（第 ${toLine} 行）。`;
}
