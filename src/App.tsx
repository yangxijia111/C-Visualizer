// 主应用：布局 + 播放器状态机（Run/Pause/Next/Previous/Restart/跳转）
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from './ui/CodeEditor';
import { VariablesPanel, MemoryPanel, CallStackPanel, ControlFlowPanel, OutputPanel } from './ui/Panels';
import { EXAMPLES } from './examples';
import { compile, runProgram } from './core/run';
import type { CompileError } from './core/errors';
import type { RunResult, ExecutionStep } from './core/steps';
import type { Snapshot } from './core/values';
import { getParser } from './core/cst';

const SPEEDS = [0.5, 1, 2, 4, 8];

export default function App() {
  const [source, setSource] = useState(EXAMPLES[4].code); // 默认：if 判断（完成标准样例）
  const [exampleId, setExampleId] = useState<string>(EXAMPLES[4].id);
  const [compileErrors, setCompileErrors] = useState<CompileError[] | null>(null);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [currentStep, setCurrentStep] = useState(-1); // -1 = 未开始（显示初始快照）
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [busy, setBusy] = useState(true); // wasm 加载中
  const runSeq = useRef(0);

  // 预热 wasm 解析器
  useEffect(() => {
    getParser()
      .then(() => setBusy(false))
      .catch((e) => {
        console.error('wasm 加载失败', e);
        setBusy(false);
      });
  }, []);

  const steps: ExecutionStep[] = runResult?.steps ?? [];
  const total = steps.length;
  const snapshot: Snapshot = runResult
    ? (currentStep < 0 ? runResult.initialSnapshot : steps[currentStep].snapshot)
    : { scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' };
  const cur = currentStep >= 0 && currentStep < total ? steps[currentStep] : null;

  const errorLines = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of compileErrors ?? []) m.set(e.line, e.message);
    return m;
  }, [compileErrors]);

  // 键盘快捷键：←/→ 步进，空格播放/暂停（编辑器未聚焦时）
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (ev.key === 'ArrowRight' && canNextRef.current) {
        setPlaying(false);
        setCurrentStep((s) => Math.min(total - 1, s + 1));
      } else if (ev.key === 'ArrowLeft' && currentStep > 0) {
        setPlaying(false);
        setCurrentStep((s) => Math.max(0, s - 1));
      } else if (ev.key === ' ' && total > 0) {
        ev.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total, currentStep]);

  // 播放
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setCurrentStep((s) => {
        if (s >= total - 1) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, total]);

  const handleRun = useCallback(async () => {
    setPlaying(false);
    setBusy(true);
    setCompileErrors(null);
    try {
      const compiled = await compile(source);
      if (!compiled.ok) {
        setCompileErrors(compiled.errors);
        setRunResult(null);
        setCurrentStep(-1);
        return;
      }
      const seq = ++runSeq.current;
      await Promise.resolve();
      if (seq !== runSeq.current) return;
      const result = runProgram(compiled.program, source);
      setRunResult(result);
      setCurrentStep(0);
    } finally {
      setBusy(false);
    }
  }, [source]);

  const loadExample = useCallback((id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setExampleId(id);
    setSource(ex.code);
    setCompileErrors(null);
    setRunResult(null);
    setCurrentStep(-1);
    setPlaying(false);
  }, []);

  const canNext = currentStep < total - 1;
  const canPrev = currentStep > 0;
  const canNextRef = useRef(canNext);
  canNextRef.current = canNext;
  const lastStep = currentStep >= 0 ? steps[currentStep] : null;

  return (
    <div className="app">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="brand">C Visualizer</div>
        <select value={exampleId} onChange={(e) => loadExample(e.target.value)} title="示例库">
          {EXAMPLES.map((ex) => (
            <option key={ex.id} value={ex.id}>{ex.title}</option>
          ))}
        </select>
        <div className="controls">
          <button className="primary" onClick={handleRun} disabled={busy} title="编译并运行">
            {busy ? '加载中…' : '▶ 运行'}
          </button>
          <button onClick={() => { setPlaying(false); setCurrentStep((s) => Math.max(0, s - 1)); }} disabled={!canPrev || currentStep < 0} title="上一步">
            ◀ 上一步
          </button>
          <button onClick={() => { setPlaying(false); setCurrentStep((s) => Math.min(total - 1, s + 1)); }} disabled={!canNext} title="下一步">
            下一步 ▶
          </button>
          <button
            onClick={() => {
              if (currentStep >= total - 1) { setCurrentStep(0); setPlaying(true); }
              else if (currentStep < 0) { setCurrentStep(0); setPlaying(true); }
              else setPlaying(!playing);
            }}
            disabled={total === 0}
            title="播放 / 暂停"
          >
            {playing ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button onClick={() => { setPlaying(false); setCurrentStep(0); }} disabled={currentStep <= 0} title="重新开始">
            ↻ 重新开始
          </button>
        </div>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="播放速度">
          {SPEEDS.map((s) => <option key={s} value={s}>{s} 步/秒</option>)}
        </select>
        <div className="step-indicator">{currentStep >= 0 ? `第 ${currentStep + 1} / ${total} 步` : `共 ${total} 步`}</div>
      </header>

      {/* 错误横幅 */}
      {compileErrors && compileErrors.length > 0 && (
        <div className="error-banner">
          {compileErrors.map((e, i) => (
            <div key={i}>
              第{e.line}行第{e.column}列：{e.message}
              {e.hint && <span className="hint">　建议：{e.hint}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 主区域 */}
      <div className="main-grid">
        <div className="left-col">
          <div className="editor-wrap">
            <CodeEditor
              value={source}
              onChange={(v) => setSource(v)}
              currentLine={cur ? cur.line : null}
              errorLines={errorLines}
            />
          </div>
          <ControlFlowPanel steps={steps} currentStep={currentStep} />
        </div>
        <div className="right-col">
          <VariablesPanel snap={snapshot} changedAddresses={cur?.changed.addresses ?? []} />
          <MemoryPanel snap={snapshot} changedAddresses={cur?.changed.addresses ?? []} />
          <CallStackPanel snap={snapshot} step={cur} />
        </div>
      </div>

      {/* 底栏：说明 + 时间轴 + 输出 */}
      <footer className="bottombar">
        <div className={`step-desc${lastStep?.status === 'runtime-error' ? ' error' : ''}${lastStep?.status === 'step-limit' || lastStep?.status === 'time-limit' ? ' warn' : ''}`}>
          {cur ? cur.description : '点击「▶ 运行」开始逐步执行。当前代码可编辑，运行后用「下一步」观察每一步的变化。'}
          {cur?.evalTrace && cur.evalTrace.length > 0 && (
            <div className="eval-trace">
              {cur.evalTrace.map((t, i) => (
                t.kind === 'eval'
                  ? <span key={i} className="trace-item">{t.text} → {formatTraceValue(t.value)}</span>
                  : <span key={i} className="trace-item skipped">{t.text}（未执行：{t.reason}）</span>
              ))}
            </div>
          )}
        </div>
        <div className="timeline-row">
          <input
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={Math.max(0, currentStep)}
            onChange={(e) => { setPlaying(false); setCurrentStep(Number(e.target.value)); }}
            disabled={total === 0}
            className="timeline"
          />
          <OutputPanel snap={snapshot} />
        </div>
      </footer>
    </div>
  );
}

function formatTraceValue(v: { type: string; value: number }): string {
  if (v.type === 'char') return `'${String.fromCharCode(v.value)}'`;
  if (v.type === 'pointer') return v.value === 0 ? 'NULL' : `#${v.value}`;
  return String(v.value);
}
