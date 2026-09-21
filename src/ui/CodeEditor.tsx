// 代码编辑器：CodeMirror 6 + C 语法高亮 + 当前行高亮 + 错误行标记
import { useEffect, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { cpp } from '@codemirror/lang-cpp';
import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';

/** 当前行高亮效果 */
const setCurrentLine = StateEffect.define<number | null>();
/** 错误行标记效果 */
const setErrorLines = StateEffect.define<Map<number, string> | null>();

const currentLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setCurrentLine)) return e.value;
    }
    return value;
  },
});

const errorLinesField = StateField.define<Map<number, string> | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setErrorLines)) return e.value;
    }
    return value;
  },
});

const decorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_value, tr) {
    const current: number | null = tr.state.field(currentLineField, false) ?? null;
    const errors = tr.state.field(errorLinesField, false) ?? null;
    const b = new RangeSetBuilder<Decoration>();
    if (errors) {
      for (const [line] of [...errors.entries()].sort((a, b2) => a[0] - b2[0])) {
        if (line >= 1 && line <= tr.state.doc.lines) {
          b.add(tr.state.doc.line(line).from, tr.state.doc.line(line).from, Decoration.line({ class: 'cm-error-line' }));
        }
      }
    }
    if (current !== null && current >= 1 && current <= tr.state.doc.lines) {
      b.add(tr.state.doc.line(current).from, tr.state.doc.line(current).from, Decoration.line({ class: 'cm-current-line' }));
    }
    return b.finish();
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  /** 当前执行行（1 基）；null = 无 */
  currentLine: number | null;
  /** 错误行 → 提示 */
  errorLines: Map<number, string>;
  readOnly?: boolean;
}

export default function CodeEditor({ value, onChange, currentLine, errorLines }: CodeEditorProps) {
  const ref = useRef<ReactCodeMirrorRef>(null);

  const extensions = useMemo(
    () => [cpp(), currentLineField, errorLinesField, decorationsField, EditorView.lineWrapping],
    [],
  );

  // 任一高亮输入（含 value：行号可能随编辑失效）变化时重新派发一次即可
  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    view.dispatch({ effects: [setCurrentLine.of(currentLine), setErrorLines.of(errorLines.size > 0 ? errorLines : null)] });
  }, [value, currentLine, errorLines]);

  return (
    <CodeMirror
      ref={ref}
      value={value}
      onChange={onChange}
      extensions={extensions}
      height="100%"
      theme="light"
      basicSetup={{ foldGutter: false, autocompletion: false, highlightActiveLine: false }}
      style={{ height: '100%', fontSize: 13 }}
    />
  );
}
