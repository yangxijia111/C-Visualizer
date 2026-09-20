// 内置库函数：printf / puts（教学特供）
// 支持格式符：%d %i %f %c %s %%；转义已在字符串字面量解析时处理
import type { Expr, StringLiteral } from '../ast';
import type { RuntimeValue } from '../values';
import { intValue, formatFloat } from '../values';
import type { Interpreter } from './index';
import { RuntimeFailure } from './index';
import { evalExpr } from './expr';

/** printf：返回输出的字符数 */
export function execPrintf(i: Interpreter, e: Extract<Expr, { kind: 'call' }>): RuntimeValue {
  const fmtArg = e.args[0];
  if (!fmtArg || fmtArg.kind !== 'string-literal') {
    throw new RuntimeFailure('E_PRINTF', 'printf 的第一个参数必须是字符串字面量', e.line);
  }
  const fmt = (fmtArg as StringLiteral).value;
  let argIdx = 1;
  let out = '';
  let charCount = 0;

  for (let k = 0; k < fmt.length; k++) {
    const c = fmt[k];
    if (c !== '%') {
      out += c;
      charCount++;
      continue;
    }
    const next = fmt[k + 1];
    if (next === '%') {
      out += '%';
      charCount++;
      k++;
      continue;
    }
    // 检查器已拒绝宽度/精度/未知格式符，这里按转换符取参数
    const arg = e.args[argIdx];
    if (!arg) {
      throw new RuntimeFailure('E_PRINTF', `printf 格式符 %${next} 缺少对应参数`, e.line);
    }
    const v = evalExpr(i, arg);
    argIdx++;
    let text: string;
    switch (next) {
      case 'd':
      case 'i':
        text = String(v.value | 0);
        break;
      case 'c':
        text = String.fromCharCode(v.value & 0xff);
        break;
      case 'f':
        text = v.value.toFixed(6);
        break;
      case 's': {
        if (arg.kind !== 'string-literal') {
          throw new RuntimeFailure('E_PRINTF', '%s 需要字符串字面量参数', e.line);
        }
        text = (arg as StringLiteral).value;
        break;
      }
      default:
        throw new RuntimeFailure('E_PRINTF', `不支持的格式符 %${next ?? ''}`, e.line);
    }
    out += text;
    charCount += text.length;
    k++;
  }

  appendOutput(i, out);
  return intValue(charCount);
}

/** puts：输出字符串并换行，返回非负数 */
export function execPuts(i: Interpreter, e: Extract<Expr, { kind: 'call' }>): RuntimeValue {
  const arg = e.args[0];
  if (!arg || arg.kind !== 'string-literal') {
    throw new RuntimeFailure('E_PRINTF', 'puts 需要恰好一个字符串字面量参数', e.line);
  }
  const text = `${(arg as StringLiteral).value}\n`;
  appendOutput(i, text);
  return intValue(text.length);
}

function appendOutput(i: Interpreter, text: string): void {
  i.output += text;
  if (i.draft) i.draft.outputDelta += text;
}

/** 浮点值格式化（供 %f 复用） */
export function formatFloatValue(v: RuntimeValue): string {
  return formatFloat(v.value);
}
