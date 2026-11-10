import { useEffect, useRef, type MutableRefObject } from "react";
import "@fontsource-variable/jetbrains-mono";
import "../../lib/monaco-workers";
import * as monaco from "monaco-editor";

const SHARED_COLORS = {
  "editor.background": "#00000000",
  "editorGutter.background": "#00000000",
  "editor.lineHighlightBackground": "#ffffff08",
  "diffEditor.diagonalFill": "#79809459",
  "diffEditorOverview.insertedForeground": "#3ddc97cc",
  "diffEditorOverview.removedForeground": "#fb6b8bcc"
};

monaco.editor.defineTheme("agenthub-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    ...SHARED_COLORS,
    "editorLineNumber.foreground": "#798094",
    "editorLineNumber.activeForeground": "#a8aebf",
    "diffEditor.insertedTextBackground": "#3ddc9738",
    "diffEditor.removedTextBackground": "#fb6b8b38",
    "diffEditor.insertedLineBackground": "#3ddc9717",
    "diffEditor.removedLineBackground": "#fb6b8b17",
    "diffEditorGutter.insertedLineBackground": "#3ddc9740",
    "diffEditorGutter.removedLineBackground": "#fb6b8b40"
  }
});

monaco.editor.defineTheme("agenthub-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    ...SHARED_COLORS,
    "editor.background": "#00000000",
    "editor.lineHighlightBackground": "#151a2308",
    "editorLineNumber.foreground": "#6f7989",
    "editorLineNumber.activeForeground": "#4a5364",
    "diffEditor.insertedTextBackground": "#0c9d6c38",
    "diffEditor.removedTextBackground": "#dc2f5538",
    "diffEditor.insertedLineBackground": "#0c9d6c17",
    "diffEditor.removedLineBackground": "#dc2f5517",
    "diffEditorGutter.insertedLineBackground": "#0c9d6c40",
    "diffEditorGutter.removedLineBackground": "#dc2f5540",
    "diffEditorOverview.insertedForeground": "#0c9d6ccc",
    "diffEditorOverview.removedForeground": "#dc2f55cc"
  }
});

function currentTheme(review = false): string {
  const mode = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return review ? `nautilo-change-review-${mode}` : `agenthub-${mode}`;
}

monaco.editor.defineTheme("nautilo-change-review-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "E7E8EA" },
    { token: "keyword", foreground: "99BFE6" },
    { token: "keyword.control", foreground: "99BFE6" },
    { token: "type", foreground: "A2CBC5" },
    { token: "type.identifier", foreground: "A2CBC5" },
    { token: "identifier", foreground: "E7E8EA" },
    { token: "function", foreground: "D8C9A6" },
    { token: "string", foreground: "B9CDA9" },
    { token: "number", foreground: "D8B7A2" },
    { token: "comment", foreground: "A8AFB8", fontStyle: "" },
    { token: "delimiter", foreground: "B3B8C0" }
  ],
  colors: {
    "editor.background": "#1B1C1E",
    "editor.foreground": "#E7E8EA",
    "editorGutter.background": "#1B1C1E",
    "editorLineNumber.foreground": "#A2A6AE",
    "editorLineNumber.activeForeground": "#A4A7AD",
    "editor.lineHighlightBackground": "#FFFFFF00",
    "editor.selectionBackground": "#9AB9DE33",
    "editor.inactiveSelectionBackground": "#9AB9DE1C",
    "editorCursor.foreground": "#E7E8EA",
    "editorWhitespace.foreground": "#45484D",
    "editorWidget.background": "#222326",
    "editorWidget.border": "#36383C",
    "editor.findMatchBackground": "#D8C9A655",
    "editor.findMatchHighlightBackground": "#D8C9A622",
    "diffEditor.insertedLineBackground": "#B4D4AF0F",
    "diffEditor.removedLineBackground": "#DCA7A70F",
    "diffEditor.insertedTextBackground": "#B4D4AF15",
    "diffEditor.removedTextBackground": "#DCA7A715",
    "diffEditorGutter.insertedLineBackground": "#B4D4AF0F",
    "diffEditorGutter.removedLineBackground": "#DCA7A70F",
    "diffEditor.diagonalFill": "#1B1C1E",
    "diffEditor.border": "#1B1C1E",
    "diffEditor.unchangedRegionBackground": "#1B1C1E",
    "diffEditor.unchangedRegionForeground": "#909399",
    "scrollbarSlider.background": "#90939925",
    "scrollbarSlider.hoverBackground": "#90939940",
    "scrollbarSlider.activeBackground": "#90939960"
  }
});

monaco.editor.defineTheme("nautilo-change-review-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "", foreground: "1B1C1F" },
    { token: "keyword", foreground: "155BBD" },
    { token: "keyword.control", foreground: "155BBD" },
    { token: "type", foreground: "086779" },
    { token: "type.identifier", foreground: "086779" },
    { token: "identifier", foreground: "1B1C1F" },
    { token: "function", foreground: "855012" },
    { token: "string", foreground: "376A32" },
    { token: "number", foreground: "9C4B1D" },
    { token: "comment", foreground: "525D6A", fontStyle: "" },
    { token: "delimiter", foreground: "30363F" }
  ],
  colors: {
    "editor.background": "#FFFFFF",
    "editor.foreground": "#1B1C1F",
    "editorGutter.background": "#FFFFFF",
    "editorLineNumber.foreground": "#59616D",
    "editorLineNumber.activeForeground": "#252A32",
    "editor.lineHighlightBackground": "#FFFFFF00",
    "editor.selectionBackground": "#155BBD22",
    "editor.inactiveSelectionBackground": "#155BBD12",
    "editorCursor.foreground": "#1B1C1F",
    "editorWhitespace.foreground": "#CDD1D6",
    "editorWidget.background": "#F7F7F8",
    "editorWidget.border": "#DEE1E5",
    "editor.findMatchBackground": "#E7C35B55",
    "editor.findMatchHighlightBackground": "#E7C35B22",
    "diffEditor.insertedLineBackground": "#2871430D",
    "diffEditor.removedLineBackground": "#AA3C420D",
    "diffEditor.insertedTextBackground": "#2871431C",
    "diffEditor.removedTextBackground": "#AA3C421C",
    "diffEditorGutter.insertedLineBackground": "#28714315",
    "diffEditorGutter.removedLineBackground": "#AA3C4215",
    "diffEditor.diagonalFill": "#FFFFFF",
    "diffEditor.border": "#FFFFFF",
    "diffEditor.unchangedRegionBackground": "#F7F7F8",
    "diffEditor.unchangedRegionForeground": "#444B55",
    "scrollbarSlider.background": "#59616D25",
    "scrollbarSlider.hoverBackground": "#59616D40",
    "scrollbarSlider.activeBackground": "#59616D60"
  }
});

export interface DiffReviewPosition { index: number; count: number }
export interface DiffReviewNavigation { move: (direction: -1 | 1) => void }

/** Monaco language id for a file path, via the registered languages' extensions. */
function languageForFile(filePath: string): string {
  const fileName=filePath.split(/[\\/]/).at(-1)?.toLowerCase()??"";
  const extension = `.${filePath.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? ""}`;
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.includes(extension)||language.filenames?.some(name=>name.toLowerCase()===fileName)) return language.id;
  }
  return "plaintext";
}

const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 12,
  lineHeight: 20,
  scrollBeyondLastLine: false,
  wordWrap: "off",
  renderWhitespace: "none",
  fixedOverflowWidgets: true
};

/**
 * VS Code-style diff editor (monaco): the pre-change file on the left
 * (read-only), the live file on the right (editable). Aligned rows, synced
 * scrolling and the change overview ruler come built in. Rendered only in the
 * artifacts drawer's edit mode and lazy-loaded, so the monaco bundle stays
 * out of the main chunk. When `before` is undefined the pre-change content
 * could not be reconstructed and a plain editor is shown instead.
 */
export default function DiffCodeEditor({ before, value, onChange, filePath, readOnly = false, sideBySide = true, hideUnchanged = false, appearance = "default", navigationRef, onReviewPosition }: {
  before?: string;
  value: string;
  onChange?: (value: string) => void;
  filePath?: string;
  readOnly?: boolean;
  sideBySide?: boolean;
  hideUnchanged?: boolean;
  appearance?: "default" | "review";
  navigationRef?: MutableRefObject<DiffReviewNavigation | null>;
  onReviewPosition?: (position: DiffReviewPosition) => void;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const connectorsRef = useRef<SVGSVGElement>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const originalModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | monaco.editor.IStandaloneCodeEditor>();
  const suppressChangeRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const positionCallback = useRef(onReviewPosition);
  positionCallback.current = onReviewPosition;

  // Mounted once per file (the parent keys the component by resolvedPath).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const language = languageForFile(filePath ?? "");
    const review = appearance === "review";
    const theme = (): string => currentTheme(review);
    const options: monaco.editor.IStandaloneEditorConstructionOptions = review ? {
      ...EDITOR_OPTIONS,
      fontFamily: '"JetBrains Mono Variable", "Noto Sans SC Variable", "Cascadia Code", Consolas, monospace',
      fontSize: 15,
      lineHeight: 29,
      fontWeight: "500",
      lineNumbers: "on",
      fontLigatures: false,
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 15,
      glyphMargin: false,
      padding: { top: 8, bottom: 24 },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "none",
      scrollbar: { verticalScrollbarSize: 7, horizontalScrollbarSize: 7, useShadows: false },
      stickyScroll: { enabled: false },
      scrollBeyondLastColumn: 8,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false }
    } : EDITOR_OPTIONS;
    const models: monaco.editor.ITextModel[] = [];
    const subscriptions: monaco.IDisposable[] = [];
    let connectorFrame = 0;
    let changeIndex = 0;
    let disposed = false;
    let editor: monaco.editor.IStandaloneDiffEditor | monaco.editor.IStandaloneCodeEditor;

    const modifiedModel = monaco.editor.createModel(value, language);
    models.push(modifiedModel);
    modifiedModelRef.current = modifiedModel;
    modifiedModel.onDidChangeContent(() => {
      if (!suppressChangeRef.current) onChangeRef.current?.(modifiedModel.getValue());
    });

    if (before !== undefined) {
      const originalModel = monaco.editor.createModel(before, language);
      originalModelRef.current = originalModel;
      models.push(originalModel);
      const diffEditor = monaco.editor.createDiffEditor(container, {
        ...options,
        theme: theme(),
        originalEditable: false,
        readOnly,
        renderSideBySide: sideBySide,
        useInlineViewWhenSpaceIsLimited: review ? false : !readOnly,
        enableSplitViewResizing: true,
        renderIndicators: review || !readOnly,
        ...(review ? { renderMarginRevertIcon: false, renderGutterMenu: false, renderOverviewRuler: false, diffCodeLens: false } : {}),
        ignoreTrimWhitespace: false,
        diffAlgorithm: "advanced",
        hideUnchangedRegions: { enabled: hideUnchanged }
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      // Reveal the first change once the (async) diff computation lands.
      let revealed = false;
      const updatePosition = (): void => {
        const count = diffEditor.getLineChanges()?.length ?? 0;
        changeIndex = Math.max(0, Math.min(changeIndex, count - 1));
        positionCallback.current?.({ count, index: count ? changeIndex + 1 : 0 });
      };
      const drawConnectors = (): void => {
        const svg = connectorsRef.current;
        const original = diffEditor.getOriginalEditor();
        const modified = diffEditor.getModifiedEditor();
        const left = original.getDomNode()?.getBoundingClientRect();
        const right = modified.getDomNode()?.getBoundingClientRect();
        if (!svg || !left || !right) return;
        const bounds = container.getBoundingClientRect();
        // Monaco aligns real changes; the connector follows those actual line positions.
        const split = right.left > left.left + 40;
        if (!split) { svg.replaceChildren(); return; }
        const x1 = left.right - bounds.left - 15;
        const x2 = right.left - bounds.left + 15;
        const mid = (x1 + x2) / 2;
        const namespace = "http://www.w3.org/2000/svg";
        const mask = document.createElementNS(namespace, "rect");
        mask.setAttribute("x", String(x1)); mask.setAttribute("y", "0");
        mask.setAttribute("width", String(x2 - x1)); mask.setAttribute("height", "100%");
        mask.setAttribute("fill", "var(--review-editor-bg)");
        const shapes: SVGElement[] = [mask];
        const range = (code: monaco.editor.ICodeEditor, start: number, end: number): [number, number] => {
          const line = Math.max(1, start);
          const top = code.getTopForLineNumber(line) - code.getScrollTop();
          if (!end) { const anchor = top + (start ? 29 : 0); return [anchor - 1, anchor + 1]; }
          return [top, code.getTopForLineNumber(end) - code.getScrollTop() + 29];
        };
        for (const change of diffEditor.getLineChanges() ?? []) {
          const [a, b] = range(original, change.originalStartLineNumber, change.originalEndLineNumber);
          const [c, d] = range(modified, change.modifiedStartLineNumber, change.modifiedEndLineNumber);
          if (Math.max(b, d) < 0 || Math.min(a, c) > bounds.height) continue;
          const path = document.createElementNS(namespace, "path");
          const color = change.modifiedEndLineNumber ? "var(--review-editor-add)" : "var(--review-editor-remove)";
          path.setAttribute("d", `M ${x1} ${a} C ${mid} ${a}, ${mid} ${c}, ${x2} ${c} L ${x2} ${d} C ${mid} ${d}, ${mid} ${b}, ${x1} ${b} Z`);
          path.setAttribute("fill", color); path.setAttribute("fill-opacity", "0.06");
          path.setAttribute("stroke", color); path.setAttribute("stroke-opacity", "0.18");
          shapes.push(path);
        }
        svg.replaceChildren(...shapes);
      };
      const scheduleConnectors = (): void => {
        if (!review || connectorFrame) return;
        connectorFrame = requestAnimationFrame(() => { connectorFrame = 0; if (!disposed) drawConnectors(); });
      };
      subscriptions.push(diffEditor.onDidUpdateDiff(() => {
        const first = diffEditor.getLineChanges()?.[0];
        if (first && !revealed) {
          diffEditor.getModifiedEditor().revealLineInCenterIfOutsideViewport(first.modifiedStartLineNumber);
          revealed = true;
        }
        updatePosition(); scheduleConnectors();
      }));
      for (const code of [diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor()]) {
        subscriptions.push(code.onDidScrollChange(scheduleConnectors), code.onDidLayoutChange(scheduleConnectors));
      }
      if (navigationRef) navigationRef.current = { move(direction) {
        const changes = diffEditor.getLineChanges() ?? [];
        if (!changes.length) return;
        changeIndex = (changeIndex + direction + changes.length) % changes.length;
        const change = changes[changeIndex];
        diffEditor.getModifiedEditor().revealLineInCenter(Math.max(1, change.modifiedStartLineNumber));
        diffEditor.getOriginalEditor().revealLineInCenter(Math.max(1, change.originalStartLineNumber));
        updatePosition(); scheduleConnectors();
      } };
      editor = diffEditor;
    } else {
      editor = monaco.editor.create(container, { ...options, theme: theme(), model: modifiedModel, readOnly });
      positionCallback.current?.({ index: 0, count: 0 });
    }
    editorRef.current = editor;

    if (review) void document.fonts.load('500 15px "JetBrains Mono Variable"').then(() => {
      if (!disposed) { monaco.editor.remeasureFonts(); editor.layout(); }
    }).catch(() => { /* The configured local monospace fallback remains available. */ });
    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(theme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      themeObserver.disconnect();
      disposed = true;
      cancelAnimationFrame(connectorFrame);
      for (const subscription of subscriptions) subscription.dispose();
      if (navigationRef) navigationRef.current = null;
      editor.dispose();
      for (const model of models) model.dispose();
      modifiedModelRef.current = null;
      originalModelRef.current = null;
      editorRef.current = undefined;
      if (review) monaco.editor.setTheme(currentTheme());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled-value sync (parent resets are the only external writes; typing
  // round-trips are no-ops because the model already holds the same text).
  useEffect(() => {
    const model = modifiedModelRef.current;
    if (model && model.getValue() !== value) {
      suppressChangeRef.current = true;
      model.setValue(value);
      suppressChangeRef.current = false;
    }
  }, [value]);
  useEffect(()=>{const model=originalModelRef.current;if(model&&before!==undefined&&model.getValue()!==before)model.setValue(before);},[before]);
  useEffect(()=>{const editor=editorRef.current;if(!editor)return;if("getOriginalEditor" in editor)editor.updateOptions({readOnly,renderSideBySide:sideBySide,renderIndicators:appearance === "review" || !readOnly,hideUnchangedRegions:{enabled:hideUnchanged}});else editor.updateOptions({readOnly});},[readOnly,sideBySide,hideUnchanged,appearance]);

  return <div className={appearance === "review" ? "review-editor-shell" : "flex min-h-0 min-w-0 flex-1"}>
    <div ref={containerRef} className="min-h-0 min-w-0 flex-1" />
    {appearance === "review" && <svg ref={connectorsRef} className="review-diff-connectors" aria-hidden />}
  </div>;
}
