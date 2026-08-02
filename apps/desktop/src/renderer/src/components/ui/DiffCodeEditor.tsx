import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
// Inlined so the worker also loads under the packaged app's file:// renderer.
// (monaco's exports map roots subpaths at esm/vs, hence no "esm/vs" prefix.)
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker&inline";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

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

function currentTheme(): string {
  return document.documentElement.classList.contains("dark") ? "agenthub-dark" : "agenthub-light";
}

/** Monaco language id for a file path, via the registered languages' extensions. */
function languageForFile(filePath: string): string {
  const extension = `.${filePath.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase() ?? ""}`;
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.includes(extension)) return language.id;
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
export default function DiffCodeEditor({ before, value, onChange, filePath }: {
  before?: string;
  value: string;
  onChange: (value: string) => void;
  filePath?: string;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const modifiedModelRef = useRef<monaco.editor.ITextModel | null>(null);
  const suppressChangeRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Mounted once per file (the parent keys the component by resolvedPath).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const language = languageForFile(filePath ?? "");
    const models: monaco.editor.ITextModel[] = [];
    let editor: monaco.editor.IStandaloneDiffEditor | monaco.editor.IStandaloneCodeEditor;

    const modifiedModel = monaco.editor.createModel(value, language);
    models.push(modifiedModel);
    modifiedModelRef.current = modifiedModel;
    modifiedModel.onDidChangeContent(() => {
      if (!suppressChangeRef.current) onChangeRef.current(modifiedModel.getValue());
    });

    if (before !== undefined) {
      const originalModel = monaco.editor.createModel(before, language);
      models.push(originalModel);
      const diffEditor = monaco.editor.createDiffEditor(container, {
        ...EDITOR_OPTIONS,
        theme: currentTheme(),
        originalEditable: false,
        readOnly: false,
        renderSideBySide: true,
        diffAlgorithm: "advanced",
        hideUnchangedRegions: { enabled: false }
      });
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });
      // Reveal the first change once the (async) diff computation lands.
      const disposable = diffEditor.onDidUpdateDiff(() => {
        const first = diffEditor.getLineChanges()?.[0];
        if (first) {
          diffEditor.getModifiedEditor().revealLineInCenterIfOutsideViewport(first.modifiedStartLineNumber);
          disposable.dispose();
        }
      });
      editor = diffEditor;
    } else {
      editor = monaco.editor.create(container, { ...EDITOR_OPTIONS, theme: currentTheme(), model: modifiedModel });
    }

    const themeObserver = new MutationObserver(() => monaco.editor.setTheme(currentTheme()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      themeObserver.disconnect();
      editor.dispose();
      for (const model of models) model.dispose();
      modifiedModelRef.current = null;
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

  return <div ref={containerRef} className="min-h-0 min-w-0 flex-1" />;
}
