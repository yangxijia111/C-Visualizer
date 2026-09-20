// 面板组件：变量监视器 / 内存·数组 / 调用栈 / 控制流 / 输出
// 只读渲染快照；变化高亮由 step.changed 驱动
import type { Snapshot, Variable, StackFrame } from '../core/values';
import { typeToString } from '../core/types';
import type { ExecutionStep, FlowEvent } from '../core/steps';

// ============ 工具 ============

function fmtValue(cell: { type: string; value: number | null; pointee?: string }, scopeVars: Variable[], snap: Snapshot): string {
  if (cell.value === null) return '未初始化';
  if (cell.type === 'char') return `'${String.fromCharCode(cell.value)}' (${cell.value})`;
  if (cell.type === 'pointer') {
    const target = findVarByAddress(snap, scopeVars, cell.value);
    return cell.value === 0 ? 'NULL' : `#${cell.value}${target ? ` (${target.name})` : ''}`;
  }
  if (cell.type === 'float' || cell.type === 'double') {
    const n = cell.value;
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(6)));
  }
  return String(cell.value);
}

function findVarByAddress(snap: Snapshot, _scopeVars: Variable[], addr: number): Variable | null {
  for (const s of snap.scopes) {
    for (const v of s.vars) {
      if (v.address === addr || (v.length && v.address !== null && addr >= v.address && addr < v.address + v.length)) {
        return v;
      }
    }
  }
  return null;
}

// ============ 变量监视器 ============

interface VariablesPanelProps {
  snap: Snapshot;
  changedAddresses: number[];
}

export function VariablesPanel({ snap, changedAddresses }: VariablesPanelProps) {
  const changed = new Set(changedAddresses);
  const hasAny = snap.scopes.some((s) => s.vars.length > 0);

  return (
    <div className="panel">
      <div className="panel-title">变量</div>
      <div className="panel-body">
        {!hasAny && <div className="placeholder">（暂无变量）</div>}
        {snap.scopes.map((scope) => (
          <div key={scope.id} className="scope-group">
            <div className="scope-label">{scope.label}</div>
            {scope.vars.length === 0 && <div className="placeholder">（空）</div>}
            {scope.vars.map((v) => {
              if (v.length !== undefined) {
                // 数组：一行概览（详情在内存面板）
                return (
                  <div key={v.name} className="var-row">
                    <span className={`var-name${changed.has(v.address!) ? ' changed' : ''}`}>{v.name}</span>
                    <span className="var-type">{typeToString(v.type)}</span>
                    <span className={`var-value${changed.has(v.address!) ? ' changed' : ''}`}>#{v.address}（数组）</span>
                  </div>
                );
              }
              const cell = v.address !== null ? snap.cells[v.address] : null;
              return (
                <div key={v.name} className="var-row">
                  <span className={`var-name${cell && changed.has(v.address!) ? ' changed' : ''}`}>{v.name}</span>
                  <span className="var-type">{typeToString(v.type)}</span>
                  <span className={`var-value${cell && changed.has(v.address!) ? ' changed' : ''}`}>
                    {cell ? fmtValue(cell, scope.vars, snap) : '未初始化'}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ 内存 / 数组面板 ============

export function MemoryPanel({ snap, changedAddresses }: VariablesPanelProps) {
  const changed = new Set(changedAddresses);
  const arrays: { v: Variable; scopeLabel: string }[] = [];
  const pointers: { v: Variable; scopeLabel: string; cell: { value: number | null } }[] = [];

  for (const s of snap.scopes) {
    for (const v of s.vars) {
      if (v.length !== undefined && v.address !== null) arrays.push({ v, scopeLabel: s.label });
      else if (v.type && typeof v.type === 'object' && 'kind' in v.type && v.type.kind === 'pointer' && v.address !== null) {
        const cell = snap.cells[v.address];
        if (cell) pointers.push({ v, scopeLabel: s.label, cell });
      }
    }
  }

  return (
    <div className="panel">
      <div className="panel-title">内存 / 数组</div>
      <div className="panel-body">
        {arrays.length === 0 && pointers.length === 0 && (
          <div className="placeholder">当前没有数组或指针</div>
        )}
        {arrays.map(({ v, scopeLabel }) => {
          const base = v.address!;
          return (
            <div key={`${scopeLabel}:${v.name}`} className="array-block">
              <div className="array-title">
                {v.name}: {typeToString(v.type)} <span className="dim">（{scopeLabel}，起始 #{base}）</span>
              </div>
              <div className="array-cells">
                {[...Array(v.length!)].map((_, i) => {
                  const cell = snap.cells[base + i];
                  const isChanged = changed.has(base + i);
                  return (
                    <div key={i} className={`array-cell${isChanged ? ' changed' : ''}`} title={`a[${i}] @ #${base + i}`}>
                      <span className="cell-idx">[{i}]</span>
                      <span className="cell-val">
                        {cell ? (cell.type === 'float' || cell.type === 'double'
                          ? String(parseFloat((cell.value ?? 0).toPrecision(6)))
                          : cell.type === 'char' && cell.value !== null ? String.fromCharCode(cell.value) : (cell.value ?? '—')) : '—'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {pointers.length > 0 && (
          <div className="pointer-block">
            <div className="array-title">指针指向</div>
            {pointers.map(({ v, cell }) => {
              const target = cell.value !== null && cell.value !== 0 ? findVarByAddress(snap, [], cell.value) : null;
              return (
                <div key={v.name} className={`pointer-row${changed.has(v.address!) ? ' changed' : ''}`}>
                  <span className="var-name">{v.name}</span>
                  <span className="pointer-arrow">{cell.value === 0 ? '→ NULL' : `→ #${cell.value}`}</span>
                  {target && (
                    <span className="pointer-target">
                      {target.length !== undefined
                        ? `${target.name}[${cell.value! - target.address!}]`
                        : `(${target.name})`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ============ 调用栈 ============

export function CallStackPanel({ snap, step }: { snap: Snapshot; step: ExecutionStep | null }) {
  const frames: StackFrame[] = snap.callStack;
  return (
    <div className="panel">
      <div className="panel-title">调用栈</div>
      <div className="panel-body">
        {frames.length === 0 && <div className="placeholder">（尚未调用 main）</div>}
        {[...frames].reverse().map((f, idx) => {
          const isTop = idx === 0;
          const scope = snap.scopes.find((s) => s.id === f.scopeId);
          const params = scope?.vars.map((v) => {
            const cell = v.address !== null ? snap.cells[v.address] : null;
            return `${v.name}=${cell && cell.value !== null ? cell.value : '—'}`;
          }).join(', ');
          return (
            <div key={`${f.scopeId}-${idx}`} className={`frame-row${isTop ? ' top' : ''}`}>
              <span className="frame-name">{f.functionName}({params})</span>
              {idx < frames.length - 1 && <span className="dim"> ← 调用自第 {frames[idx + 1] ? f.callLine : f.callLine} 行</span>}
            </div>
          );
        })}
        {step?.status === 'program-end' && <div className="placeholder">（程序已返回）</div>}
      </div>
    </div>
  );
}

// ============ 控制流面板 ============

function flowText(f: FlowEvent): { text: string; cls: string } {
  switch (f.kind) {
    case 'if-branch':
      return { text: `if (${f.conditionText}) = ${f.conditionValue} → ${f.taken ? '进入分支' : '跳过分支'}`, cls: 'branch' };
    case 'loop-check':
      return { text: `${f.loopType} 条件 ${f.conditionText} = ${f.value} → ${f.entered ? '进入循环体' : '退出循环'}`, cls: f.entered ? 'loop' : 'loop-exit' };
    case 'loop-update':
      return { text: `更新 ${f.text} → ${f.newValue}，回到条件`, cls: 'loop' };
    case 'break':
      return { text: `break：跳出${f.from === 'switch' ? ' switch' : '循环'}`, cls: 'jump' };
    case 'continue':
      return { text: 'continue：跳到下一轮', cls: 'jump' };
    case 'switch-discriminant':
      return { text: `switch ${f.text} = ${f.value}`, cls: 'branch' };
    case 'case-match':
      return { text: `→ ${f.matched ? `命中 ${f.caseText}` : `未命中任何 case${f.caseText === 'default' ? '' : '，走 default'}`}`, cls: 'branch' };
    case 'case-fallthrough':
      return { text: `穿透：${f.fromCase} → ${f.toCase}（无 break）`, cls: 'warn' };
    case 'goto':
      return { text: `goto ${f.label}：第 ${f.fromLine} 行 → 第 ${f.toLine} 行`, cls: 'jump' };
    case 'short-circuit':
      return { text: `短路 ${f.op}：左侧 = ${f.leftValue}，右侧${f.rightSkipped ? '未执行' : '已执行'}`, cls: 'warn' };
    case 'call':
      return { text: `调用 ${f.functionName}(${f.args.join(', ')})，压栈`, cls: 'call' };
    case 'return':
      return { text: `${f.functionName} 返回${f.value ? ` ${f.value}` : ''}，弹栈`, cls: 'call' };
    default:
      return { text: JSON.stringify(f), cls: '' };
  }
}

export function ControlFlowPanel({ steps, currentStep }: { steps: ExecutionStep[]; currentStep: number }) {
  const cur = steps[currentStep];
  const history: FlowEvent[] = [];
  for (let i = Math.max(0, currentStep - 8); i <= currentStep && i < steps.length; i++) {
    history.push(...steps[i].flowEvents);
  }
  const past = history.slice(0, -1);
  const now = cur?.flowEvents ?? [];

  return (
    <div className="panel">
      <div className="panel-title">控制流</div>
      <div className="panel-body">
        {history.length === 0 && now.length === 0 && <div className="placeholder">（运行后显示控制流轨迹）</div>}
        {past.map((f, i) => {
          const { text, cls } = flowText(f);
          return <div key={`h${i}`} className={`flow-row past ${cls}`}>{text}</div>;
        })}
        {now.map((f, i) => {
          const { text, cls } = flowText(f);
          return <div key={`n${i}`} className={`flow-row current ${cls}`}>{text}</div>;
        })}
      </div>
    </div>
  );
}

// ============ 输出面板 ============

export function OutputPanel({ snap }: { snap: Snapshot }) {
  const lines = snap.output;
  return (
    <div className="panel output-panel">
      <div className="panel-title">输出</div>
      <div className="panel-body output-body">
        {lines.length === 0 ? <span className="placeholder">（暂无输出）</span> : <pre className="output-pre">{lines}</pre>}
      </div>
    </div>
  );
}
