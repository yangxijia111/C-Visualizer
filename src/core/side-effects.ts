// 副作用求值顺序静态分析（SEMANTIC_MODEL §6.2）
// 目标：C 教学工具不得把「未定义 / 未指定求值顺序」的代码解释为确定结果。
// 保守策略（宁可放过不误杀）：
//  - 区域 = 完整表达式内被 && / || 分隔的两侧（序列点）；其余部分同区域
//  - R1 双写：同一变量的写副作用出现 ≥ 2 次（i++ + i++、i = i++、f(i++, i++)）
//  - R2 读写竞争：变量存在写副作用且在同区域还有其他出现（i++ + i、a[i] = i++、f(i++, i)）
//  - 赋值豁免：赋值（含复合）目标变量的写与该赋值子树中同名的纯读取视为有序
//    （C11 6.5.16p3：赋值副作用 sequenced after 左右操作数的值计算），
//    x = x + 1 / x += x / *p = *p + 1 合法；豁免不覆盖另一个写（i = i++ 仍为 R1）
//  - && / || 左右两侧互不冲突（C11 序列点）；函数调用的实参之间同区域分析
import type { Expr } from './ast';

/** 一处未定义行为（按变量名去重，每变量最多报一条） */
export interface UBViolation {
  name: string;
  rule: 'double-write' | 'read-write-race';
  /** 完整表达式节点（错误定位用） */
  at: Expr;
}

/** 区域内各变量的读取 / 写副作用次数 */
interface Counts {
  reads: Map<string, number>;
  writes: Map<string, number>;
}

function emptyCounts(): Counts {
  return { reads: new Map(), writes: new Map() };
}

function addCount(m: Map<string, number>, name: string, n = 1): void {
  m.set(name, (m.get(name) ?? 0) + n);
}

function mergeCounts(a: Counts, b: Counts): Counts {
  const out = emptyCounts();
  for (const [k, v] of a.reads) out.reads.set(k, v);
  for (const [k, v] of b.reads) addCount(out.reads, k, v);
  for (const [k, v] of a.writes) out.writes.set(k, v);
  for (const [k, v] of b.writes) addCount(out.writes, k, v);
  return out;
}

/** 左值的（写目标基础名, 地址计算读取） */
function lvalueParts(e: Expr): { base: string; addr: Counts } {
  if (e.kind === 'identifier') return { base: e.name, addr: emptyCounts() };
  if (e.kind === 'array-access') {
    // a[i] 的地址计算：下标求值（读取 i 等）；数组名本身不读值（退化为地址）
    return { base: e.array.name, addr: analyzeNode(e.index, null) };
  }
  if (e.kind === 'deref') {
    // *p 的地址计算：求值指针表达式 p（读取 p）
    return { base: baseName(e.target), addr: analyzeNode(e.target, null) };
  }
  return { base: '', addr: emptyCounts() };
}

/** 表达式树最内层的基础变量名（identifier / 数组名；其他返回空串） */
function baseName(e: Expr): string {
  if (e.kind === 'identifier') return e.name;
  if (e.kind === 'array-access') return e.array.name;
  if (e.kind === 'deref') return baseName(e.target);
  return '';
}

/** 无去重的递归分析（内部使用；检查通过全局 violations 收集器去重） */
function analyzeNode(e: Expr, acc: ViolationCollector | null): Counts {
  switch (e.kind) {
    case 'int-literal':
    case 'float-literal':
    case 'char-literal':
    case 'string-literal':
      return emptyCounts();
    case 'identifier': {
      const c = emptyCounts();
      addCount(c.reads, e.name);
      return c;
    }
    case 'unary':
      return analyzeNode(e.operand, acc);
    case 'pre-incdec':
    case 'post-incdec': {
      const { base, addr } = lvalueParts(e.target);
      addCount(addr.writes, base);
      return addr;
    }
    case 'binary': {
      if (e.op === '&&' || e.op === '||') {
        // 序列点：左右两侧是独立区域，互不冲突；计数不再向上冒泡
        checkRegion(analyzeNode(e.left, acc), acc);
        checkRegion(analyzeNode(e.right, acc), acc);
        return emptyCounts();
      }
      const c = mergeCounts(analyzeNode(e.left, acc), analyzeNode(e.right, acc));
      checkRegion(c, acc);
      return c;
    }
    case 'assign': {
      const { base, addr } = lvalueParts(e.target);
      const valueC = analyzeNode(e.value, acc);
      const c = mergeCounts(valueC, addr);
      // 右值与下标地址计算之间的跨冲突（a[i] = i++）
      checkRegion(c, acc);
      // 赋值豁免：目标写的值计算先于写；同名读取不计冲突
      const exempt = (valueC.reads.get(base) ?? 0) + (addr.reads.get(base) ?? 0);
      if (exempt > 0) {
        const left = (c.reads.get(base) ?? 0) - exempt;
        if (left > 0) c.reads.set(base, left);
        else c.reads.delete(base);
      }
      if (base) addCount(c.writes, base);
      return c;
    }
    case 'addr-of': {
      // &x 不读 x 的值，但保守按读取处理（把地址传给可能写入的函数时存在竞争）
      const c = analyzeNode(e.target, acc);
      const base = baseName(e.target);
      if (base) addCount(c.reads, base);
      return c;
    }
    case 'deref': {
      // *p 读值：求值指针表达式（读取 p）
      return analyzeNode(e.target, acc);
    }
    case 'array-access': {
      const c = analyzeNode(e.index, acc);
      addCount(c.reads, e.array.name);
      return c;
    }
    case 'call': {
      // 实参之间无序列点：同区域合并分析（f(i++, i++) / printf("%d", i, i++)）
      let c = emptyCounts();
      for (const arg of e.args) {
        c = mergeCounts(c, analyzeNode(arg, acc));
      }
      checkRegion(c, acc);
      return c;
    }
    default:
      return emptyCounts();
  }
}

/** 区域规则检查（R1 / R2）；违规经收集器按变量名去重 */
function checkRegion(c: Counts, acc: ViolationCollector | null): void {
  if (!acc) return;
  for (const [name, w] of c.writes) {
    if (w >= 2) {
      acc.report(name, 'double-write');
    } else if ((c.reads.get(name) ?? 0) >= 1) {
      acc.report(name, 'read-write-race');
    }
  }
}

class ViolationCollector {
  private byName = new Map<string, UBViolation>();
  constructor(private root: Expr) {}
  report(name: string, rule: UBViolation['rule']): void {
    if (name && !this.byName.has(name)) {
      this.byName.set(name, { name, rule, at: this.root });
    }
  }
  violations(): UBViolation[] {
    return [...this.byName.values()];
  }
}

/** 分析一个完整表达式（语句表达式 / 初始化式 / 条件 / return 值等顶层入口） */
export function analyzeFullExpr(e: Expr): UBViolation[] {
  const acc = new ViolationCollector(e);
  checkRegion(analyzeNode(e, acc), acc);
  return acc.violations();
}

/**
 * 分析一组同区域表达式（数组初始化列表：C11 中列表元素之间求值无序，
 * {1, i++, i} 同样是读写竞争，作为单一区域分析）。
 */
export function analyzeFullExprList(es: Expr[]): UBViolation[] {
  if (es.length === 0) return [];
  const acc = new ViolationCollector(es[0]);
  let c = emptyCounts();
  for (const e of es) {
    c = mergeCounts(c, analyzeNode(e, acc));
  }
  checkRegion(c, acc);
  return acc.violations();
}
