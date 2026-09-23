// 主应用：布局 + 播放器状态机（Run/Pause/Next/Previous/Restart/跳转）
// v1.2：compile + 解释执行在 Web Worker（RuntimeClient）；主线程只持有
// Checkpoint+Delta 形式的 trace（TraceStore），任意步骤快照按需重建。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from './ui/CodeEditor';
import { VariablesPanel, MemoryPanel, CallStackPanel, ControlFlowPanel, OutputPanel } from './ui/Panels';
import { EXAMPLES } from './examples';
import type { CompileError } from './core/errors';
import type { Snapshot } from './core/values';
import { TraceStore } from './core/trace/trace-store';
import { RuntimeClient } from './worker/client';
import { PLAYBACK_SPEEDS, nextStep, prevStep, advancePlaying, playButtonAction, timelineValue } from './ui/playback';
import { nextDirtyState, shouldDisablePlayback, shouldDisableRun, visibleCurrentLine, isStaleResult } from './ui/run-state';

const EMPTY_SNAPSHOT: Snapshot = { scopes: [], cells: {}, callStack: [], nextAddress: 1, output: '' };

export default function App() {
  const [source, setSource] = useState(EXAMPLES[4].code); // 默认：if 判断（完成标准样例）
  const [exampleId, setExampleId] = useState<string>(EXAMPLES[4].id);
  const [compileErrors, setCompileErrors] = useState<CompileError[] | null>(null);
  const [currentStep, setCurrentStep] = useState(-1); // -1 = 未开始（显示初始快照）
  const [playing, setPlaying] = useState(false);
  const [sourceDirty, setSourceDirty] = useState(false); // 源码相对上一次成功运行已被修改（旧结果 = 上一次运行）
  const [speed, setSpeed] = useState(2);
  const [busy, setBusy] = useState(true); // Worker/解析器预热中
  const [running, setRunning] = useState(false); // 正在执行（Worker 侧）
  const [progress, setProgress] = useState(0); // 已流式接收的步数（运行中显示）
  const [traceFinished, setTraceFinished] = useState(false); // 展示用 trace 已终态（可播放）
  const [parserError, setParserError] = useState<string | null>(null); // Worker/解析器异常提示（致命，禁用运行）
  const [runError, setRunError] = useState<string | null>(null); // 单次运行的意外失败（非致命，可重试）

  // 双 TraceStore：building 接收流式批次；终态后与 display 交换。
  // 编译失败/取消时 building 被丢弃，display 保留上一次完整运行（与 v1.1 旧结果语义一致）
  const displayStoreRef = useRef<TraceStore>(new TraceStore());
  const buildingStoreRef = useRef<TraceStore>(new TraceStore());
  // 运行竞态守卫：只有最新一次 client.run 的回调允许落地（旧 run 的终态一律忽略）
  const runIdRef = useRef(-1);
  const clientRef = useRef<RuntimeClient | null>(null);
  const getClient = useCallback((): RuntimeClient => {
    if (!clientRef.current) clientRef.current = new RuntimeClient();
    return clientRef.current;
  }, []);

  // 预热 Worker（wasm 解析器在 Worker 内初始化）
  useEffect(() => {
    getClient()
      .ensureReady()
      .then(() => setBusy(false))
      .catch((e: unknown) => {
        console.error('worker 初始化失败', e);
        setParserError('解析器（tree-sitter wasm）加载失败：请检查网络连接后刷新页面重试。');
        setBusy(false);
      });
  }, [getClient]);

  const display = displayStoreRef.current;
  // 播放数据面：total 仅在终态后开放（流式中的部分 trace 不可播放）
  const total = traceFinished ? display.length : 0;
  const snapshot: Snapshot = traceFinished
    ? (currentStep < 0 ? display.getInitialSnapshot() ?? EMPTY_SNAPSHOT : display.getSnapshot(currentStep) ?? EMPTY_SNAPSHOT)
    : EMPTY_SNAPSHOT;
  const cur = traceFinished ? display.getStepView(currentStep) : null;
  const busyOrRunning = busy || running;
  const playbackLocked = shouldDisablePlayback({ busy: busyOrRunning, parserError, sourceDirty, total });

  const errorLines = useMemo(() => {
    const m = new Map<number, string>();
    for (const e of compileErrors ?? []) m.set(e.line, e.message);
    return m;
  }, [compileErrors]);

  // 键盘快捷键：←/→ 步进，空格播放/暂停（编辑器未聚焦时；播放锁定时一律不响应）
  const playbackLockedRef = useRef(playbackLocked);
  playbackLockedRef.current = playbackLocked;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (ev.key === 'ArrowRight' && canNextRef.current && !playbackLockedRef.current) {
        setPlaying(false);
        setCurrentStep((s) => nextStep(s, total));
      } else if (ev.key === 'ArrowLeft' && currentStep > 0 && !playbackLockedRef.current) {
        setPlaying(false);
        setCurrentStep((s) => prevStep(s));
      } else if (ev.key === ' ' && total > 0 && !playbackLockedRef.current) {
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
        const next = advancePlaying(s, total);
        if (next === null) {
          setPlaying(false);
          return s;
        }
        return next;
      });
    }, 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, total]);

  // 停止当前运行：terminate 硬取消 + 使旧 run 回调失效（building 中间态直接丢弃）
  const stopRun = useCallback(() => {
    runIdRef.current = -1;
    clientRef.current?.cancelActive();
    setRunning(false);
    setProgress(0);
  }, []);

  const handleRun = useCallback(() => {
    if (parserError) return; // 解析器不可用时禁止运行
    setPlaying(false);
    setCompileErrors(null);
    setRunError(null);
    setRunning(true);
    setProgress(0);
    const rid = getClient().run(source, undefined, {
      onStarted: (initialSnapshot) => {
        if (runIdRef.current !== rid) return; // 已被更新的 run 取代
        buildingStoreRef.current.appendInitial(initialSnapshot, source);
      },
      onBatch: (startIndex, entries) => {
        if (runIdRef.current !== rid) return;
        buildingStoreRef.current.appendBatch(startIndex, entries);
        setProgress(buildingStoreRef.current.length);
      },
      onFinished: (status, output) => {
        if (runIdRef.current !== rid) return;
        const building = buildingStoreRef.current;
        building.finalize(status, output);
        // 终态交换：building 成为新的展示 trace（含 cancelled 的部分结果也可播放）
        displayStoreRef.current = building;
        buildingStoreRef.current = new TraceStore();
        setCurrentStep(0);
        setTraceFinished(true);
        setSourceDirty((d) => nextDirtyState(d, { type: 'run-success' }));
        setRunning(false);
      },
      onCompileError: (errors) => {
        if (runIdRef.current !== rid) return;
        // 编译失败：旧 trace 保留但继续标记为旧结果（sourceDirty 不变 → 播放控制保持禁用）
        setCompileErrors(errors);
        setRunning(false);
      },
      onRunError: (message) => {
        if (runIdRef.current !== rid) return;
        setRunError(message); // 非致命：显示错误但运行按钮保持可用（可重试）
        setRunning(false);
      },
      onFatalError: (message) => {
        setParserError(message);
        setRunning(false);
      },
    });
    runIdRef.current = rid;
  }, [source, parserError, getClient]);

  // 编辑器输入：源码一旦变化，旧 trace 即为「上一次运行」的结果，停止播放；
  // 若 Worker 正在执行，自动硬取消当前运行（其结果不再适用，任务书 §24）
  const handleSourceChange = useCallback((v: string) => {
    setSource(v);
    setSourceDirty((d) => nextDirtyState(d, { type: 'edit' }));
    setPlaying(false);
    if (clientRef.current?.activeRunId != null) stopRun();
  }, [stopRun]);

  const loadExample = useCallback((id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    setExampleId(id);
    setSource(ex.code);
    setCompileErrors(null);
    setRunError(null);
    setCurrentStep(-1);
    setPlaying(false);
    // 上下文整体重置：终止在跑的 run 并丢弃展示 trace（与 v1.1 load-example 语义一致）
    stopRun();
    displayStoreRef.current = new TraceStore();
    setTraceFinished(false);
    setSourceDirty((d) => nextDirtyState(d, { type: 'load-example' }));
  }, [stopRun]);

  const canNext = currentStep < total - 1;
  const canPrev = currentStep > 0;
  const canNextRef = useRef(canNext);
  canNextRef.current = canNext;
  const lastStep = cur;
  const staleResult = isStaleResult(sourceDirty, traceFinished);

  return (
    <div className="app">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="brand">C Visualizer</div>
        <select value={exampleId} onChange={(e) => loadExample(e.target.value)} title="示例库" aria-label="选择示例">
          {EXAMPLES.map((ex) => (
            <option key={ex.id} value={ex.id}>{ex.title}</option>
          ))}
        </select>
        <div className="controls">
          <button className="primary" onClick={handleRun} disabled={shouldDisableRun(busyOrRunning, parserError)} title="编译并运行">
            {running ? '运行中…' : busy ? '加载中…' : '▶ 运行'}
          </button>
          {running && (
            <button onClick={stopRun} title="停止当前执行">■ 停止</button>
          )}
          <button onClick={() => { setPlaying(false); setCurrentStep((s) => prevStep(s)); }} disabled={playbackLocked || !canPrev} title="上一步">
            ◀ 上一步
          </button>
          <button onClick={() => { setPlaying(false); setCurrentStep((s) => nextStep(s, total)); }} disabled={playbackLocked || !canNext} title="下一步">
            下一步 ▶
          </button>
          <button
            onClick={() => {
              const action = playButtonAction(currentStep, total, playing);
              setCurrentStep(action.step);
              setPlaying(action.play);
            }}
            disabled={playbackLocked}
            title="播放 / 暂停"
          >
            {playing ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button onClick={() => { setPlaying(false); setCurrentStep(0); }} disabled={playbackLocked || currentStep <= 0} title="重新开始">
            ↻ 重新开始
          </button>
        </div>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="播放速度" aria-label="播放速度（步/秒）">
          {PLAYBACK_SPEEDS.map((s) => <option key={s} value={s}>{s} 步/秒</option>)}
        </select>
        <div className="step-indicator">
          {running
            ? `正在执行… 已生成 ${progress} 步`
            : currentStep >= 0 ? `第 ${currentStep + 1} / ${total} 步` : `共 ${total} 步`}
        </div>
      </header>

      {/* 错误横幅 */}
      {parserError && (
        <div className="error-banner" role="alert">
          {parserError}
        </div>
      )}
      {compileErrors && compileErrors.length > 0 && (
        <div className="error-banner">
          {compileErrors.map((e, i) => (
            <div key={i}>
              第{e.line}行第{e.column}列：{e.message}
              {e.hint && <span className="hint"> 建议：{e.hint}</span>}
            </div>
          ))}
        </div>
      )}
      {runError && (
        <div className="error-banner" role="alert">
          {runError}
        </div>
      )}

      {/* 旧结果提示横幅：源码已修改，右侧可视化仍为上一次运行的数据 */}
      {staleResult && (
        <div className="stale-result-banner" role="status">
          <span>⚠ 源码已修改，当前可视化结果来自上一次运行，请重新运行。</span>
          <button className="rerun-btn" onClick={handleRun} disabled={shouldDisableRun(busyOrRunning, parserError)} title="用当前源码重新编译并运行">
            重新运行
          </button>
        </div>
      )}

      {/* 主区域 */}
      <div className="main-grid">
        <div className="left-col">
          <div className="editor-wrap">
            <CodeEditor
              value={source}
              onChange={handleSourceChange}
              currentLine={visibleCurrentLine(sourceDirty, cur)}
              errorLines={errorLines}
            />
          </div>
          <ControlFlowPanel records={display.getRecords()} currentStep={traceFinished ? currentStep : -1} />
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
            value={timelineValue(currentStep)}
            onChange={(e) => { setPlaying(false); setCurrentStep(Number(e.target.value)); }}
            disabled={playbackLocked}
            className="timeline"
            aria-label="执行时间轴"
            title="拖动跳转到任意步骤"
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
