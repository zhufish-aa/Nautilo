import type { editor } from "monaco-editor";

export type EditorModels = { modified: editor.ITextModel; original?: editor.ITextModel; view?: editor.ICodeEditorViewState | editor.IDiffEditorViewState | null };

/** Each mounted editor owns its models. Evict only detached files; never evict
 * the model attached to an in-flight diff or a user's active edit buffer. */
export class EditorModelCache {
  private readonly files = new Map<string, EditorModels>();
  get(key: string): EditorModels | undefined {
    const models = this.files.get(key);
    if (models) { this.files.delete(key); this.files.set(key, models); }
    return models;
  }
  set(key: string, models: EditorModels): void { this.files.set(key, models); this.trim(key); }
  trim(active: string): void {
    let bytes = [...this.files.values()].reduce((n, value) => n + (value.modified.getValueLength() + (value.original?.getValueLength() ?? 0)) * 2, 0);
    for (const [key, value] of this.files) {
      if (this.files.size <= 20 && bytes <= 16 * 1024 * 1024) break;
      if (key === active) continue;
      bytes -= (value.modified.getValueLength() + (value.original?.getValueLength() ?? 0)) * 2;
      value.modified.dispose(); value.original?.dispose(); this.files.delete(key);
    }
  }
  clear(): void { for (const value of this.files.values()) { value.modified.dispose(); value.original?.dispose(); } this.files.clear(); }
}
