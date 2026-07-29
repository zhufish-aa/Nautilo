import { create } from "zustand";
import type { FileReference } from "../lib/file-references";

interface FilePreviewState {
  target: FileReference | null;
  /** Directories (active project root) used to resolve relative references. */
  basePaths: string[];
  open: (target: FileReference) => void;
  close: () => void;
  setBasePaths: (paths: string[]) => void;
}

export const useFilePreviewStore = create<FilePreviewState>()((set) => ({
  target: null,
  basePaths: [],
  open: (target) => set({ target }),
  close: () => set({ target: null }),
  setBasePaths: (paths) => set({ basePaths: paths })
}));

export function openFilePreview(target: FileReference): void {
  useFilePreviewStore.getState().open(target);
}
