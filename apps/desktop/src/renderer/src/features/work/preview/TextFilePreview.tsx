import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import "../../../lib/monaco-workers";
import { useUiReducedMotion } from "../../../lib/ui-motion";
import { PreviewCopyButton } from "./PreviewCopyButton";

const themeColors = {
  "editor.background": "#00000000",
  "editorGutter.background": "#00000000",
  "scrollbarSlider.background": "#8080803b",
  "scrollbarSlider.hoverBackground": "#80808066",
  "scrollbarSlider.activeBackground": "#80808080",
  "editor.lineHighlightBackground": "#8080800e",
  "editorBracketMatch.background": "#80808026",
  "editorBracketMatch.border": "#80808059",
  "editor.findMatchBackground": "#f59e0b38",
  "editor.findMatchBorder": "#f59e0b",
  "editor.findMatchHighlightBackground": "#f59e0b26"
};

for (const [name, base, colors] of [
  ["nautilo-file-dark", "vs-dark", ["93c5fd", "aaca9b", "fbbf24", "c4b5fd", "989492", "929298"]],
  ["nautilo-file-light", "vs", ["215784", "37673c", "85520d", "655097", "68625e", "626269"]]
] as const) {
  monaco.editor.defineTheme(name, {
    base, inherit: true,
    colors: { ...themeColors, "editorLineNumber.foreground": base === "vs-dark" ? "#ffffff54" : "#11111173" },
    rules: [
      { token: "string.key", foreground: colors[0] },
      { token: "key", foreground: colors[0] },
      { token: "attribute.name", foreground: colors[0] },
      { token: "string", foreground: colors[1] },
      { token: "number", foreground: colors[2] },
      { token: "constant", foreground: colors[2] },
      { token: "keyword", foreground: colors[3] },
      { token: "type", foreground: colors[3] },
      { token: "comment", foreground: colors[4], fontStyle: "italic" },
      { token: "delimiter", foreground: colors[5] }
    ]
  });
}

export interface PreviewLines { start: number; end: number }
export interface PreviewEditorHandle { find(): void; reveal(line: number): void }

export const TextFilePreview = forwardRef<PreviewEditorHandle, {
  text: string;
  path: string;
  wrap: boolean;
  fontSize: number;
  zh: boolean;
  onQuote(reference: string): void;
  onSelection(selection: PreviewLines | undefined): void;
}>(function TextFilePreview({ text, path, wrap, fontSize, zh, onQuote, onSelection }, handle) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>();
  const pulse = useRef<(line: number) => void>();
  const float = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<PreviewLines>();
  const selectionChanged = useRef(onSelection);
  selectionChanged.current = onSelection;
  const reduced = useUiReducedMotion();
  const initialText = useRef(text);

  useLayoutEffect(() => {
    if (!host.current) return;
    const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
    const extension = filename.includes(".") ? "." + filename.split(".").at(-1) : "";
    const language = monaco.languages.getLanguages().find(item => item.filenames?.includes(filename)
      || item.extensions?.includes(extension))?.id ?? "plaintext";
    const model = monaco.editor.createModel(initialText.current, language);
    const applyTheme = (): void => monaco.editor.setTheme(document.documentElement.classList.contains("dark") ? "nautilo-file-dark" : "nautilo-file-light");
    const instance = monaco.editor.create(host.current, {
      model, automaticLayout: true, readOnly: true, domReadOnly: true, editContext: false,
      minimap: { enabled: false }, glyphMargin: false, lineNumbersMinChars: 3, lineDecorationsWidth: 22,
      fontFamily: '"Noto Sans SC Variable"',
      fontSize: 13, lineHeight: 21, fontLigatures: true, padding: { top: 14, bottom: 14 },
      scrollBeyondLastLine: false, folding: true, showFoldingControls: "mouseover", foldingHighlight: true,
      guides: { indentation: true, highlightActiveIndentation: true }, matchBrackets: "always",
      renderLineHighlight: "all", renderLineHighlightOnlyWhenFocus: false, renderWhitespace: "none",
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, useShadows: false },
      overviewRulerLanes: 0, hideCursorInOverviewRuler: true, contextmenu: false,
      stickyScroll: { enabled: false }, occurrencesHighlight: "off", selectionHighlight: false,
      find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: "never" },
      unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false }
    });
    editor.current = instance;
    void document.fonts.load(`${fontSize}px "Noto Sans SC Variable"`, "n中→").then(() => {
      if (editor.current === instance) { monaco.editor.remeasureFonts(); instance.layout(); }
    }).catch(() => { /* The system font remains available. */ });
    applyTheme();
    const theme = new MutationObserver(applyTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const selected = instance.createDecorationsCollection();
    const flashed = instance.createDecorationsCollection();
    const folded = instance.createDecorationsCollection();
    let anchor: number | undefined;
    let dragging = false;
    let current: PreviewLines | undefined;
    let timer: number | undefined;
    function align(): void {
      if (!float.current || !current) return;
      const top = instance.getTopForLineNumber(current.start) - instance.getScrollTop();
      float.current.style.top = Math.min(Math.max(top - 36, 7), Math.max(7, instance.getLayoutInfo().height - 38)) + "px";
    }
    function select(line?: number): void {
      const start = line !== undefined && anchor !== undefined ? Math.min(anchor, line) : undefined;
      const end = line !== undefined && anchor !== undefined ? Math.max(anchor, line) : undefined;
      if (current?.start === start && current?.end === end) return;
      current = start !== undefined && end !== undefined ? { start, end } : undefined;
      selected.set(current ? [{
        range: new monaco.Range(current.start, 1, current.end, 1),
        options: { isWholeLine: true, className: "preview-selected-line", linesDecorationsClassName: "preview-selected-gutter" }
      }] : []);
      setSelection(current);
      selectionChanged.current(current);
      align();
    }
    const kinds = monaco.editor.MouseTargetType;
    const down = instance.onMouseDown(({ target, event }) => {
      if (!event.leftButton) return;
      if (target.type === kinds.GUTTER_LINE_NUMBERS && target.position) {
        if (!event.shiftKey || anchor === undefined) anchor = target.position.lineNumber;
        dragging = true;
        select(target.position.lineNumber);
      } else if (target.type === kinds.CONTENT_TEXT || target.type === kinds.CONTENT_EMPTY) {
        anchor = undefined;
        select();
      }
    });
    const move = instance.onMouseMove(({ target, event }) => {
      if (dragging && event.leftButton && target.position) select(target.position.lineNumber);
    });
    const release = (): void => { dragging = false; };
    window.addEventListener("pointerup", release);
    const scroll = instance.onDidScrollChange(align);
    const layout = instance.onDidLayoutChange(align);
    let foldingFrame = 0;
    function updateFoldedLines(): void {
      const view = instance.saveViewState()?.contributionsState["editor.contrib.folding"] as
        { collapsedRegions?: { startLineNumber: number; endLineNumber: number; isCollapsed: boolean }[] } | undefined;
      folded.set((view?.collapsedRegions ?? []).filter(range => range.isCollapsed).map(range => {
        const line = range.startLineNumber;
        const column = model.getLineMaxColumn(line);
        return { range: new monaco.Range(line, column, line, column), options: {
          showIfCollapsed: true,
          after: { content: " " + (range.endLineNumber - line) + (zh ? " 行 " : " lines "), inlineClassName: "preview-fold-count" },
          description: "Folded lines"
        } };
      }));
    }
    const folding = instance.onDidChangeHiddenAreas(() => {
      cancelAnimationFrame(foldingFrame);
      foldingFrame = requestAnimationFrame(updateFoldedLines);
    });
    pulse.current = (value): void => {
      const line = Math.min(Math.max(1, value), model.getLineCount());
      instance.revealLineInCenter(line, reduced ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth);
      window.clearTimeout(timer);
      flashed.set([{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "preview-flash-line" } }]);
      timer = window.setTimeout(() => flashed.clear(), 1200);
    };
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(foldingFrame);
      window.removeEventListener("pointerup", release);
      [down, move, scroll, layout, folding].forEach(item => item.dispose());
      theme.disconnect();
      pulse.current = undefined;
      editor.current = undefined;
      instance.dispose();
      model.dispose();
      selectionChanged.current(undefined);
    };
  }, [path, reduced, zh]);

  useImperativeHandle(handle, () => ({
    find: () => { editor.current?.focus(); editor.current?.trigger("preview", "actions.find", undefined); },
    reveal: line => pulse.current?.(line)
  }), []);

  useLayoutEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model || model.getValue() === text) return;
    const view = instance.saveViewState();
    const top = instance.getScrollTop(), left = instance.getScrollLeft();
    model.setValue(text);
    instance.restoreViewState(view);
    instance.setScrollPosition({ scrollTop: top, scrollLeft: left });
  }, [text, path, reduced, zh]);

  useEffect(() => {
    editor.current?.updateOptions({ wordWrap: wrap ? "on" : "off", fontSize, lineHeight: Math.round(fontSize * 1.65) });
  }, [wrap, fontSize, path, reduced, zh]);

  useLayoutEffect(() => {
    const instance = editor.current;
    if (!instance || !float.current || !selection) return;
    const top = instance.getTopForLineNumber(selection.start) - instance.getScrollTop();
    float.current.style.top = Math.min(Math.max(top - 36, 7), Math.max(7, instance.getLayoutInfo().height - 38)) + "px";
  }, [selection]);

  const start = selection?.start;
  const end = selection?.end;
  const suffix = start === end ? String(start) : start + "-" + end;
  return <div className="preview-editor-card">
    <div ref={host} className="preview-editor-host" />
    {start !== undefined && end !== undefined && <div ref={float} className="preview-selection-tools">
      <button type="button" onClick={() => onQuote(path + ":" + suffix)}>
        {zh ? "引用到对话" : "Quote in chat"} <span>{path.split("/").at(-1)}:{suffix}</span>
      </button>
      <PreviewCopyButton value={text.split(/\r\n?|\n/).slice(start - 1, end).join("\n")} label={zh ? "复制选区" : "Copy selected lines"} />
    </div>}
  </div>;
});
