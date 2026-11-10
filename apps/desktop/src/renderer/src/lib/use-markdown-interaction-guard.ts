import { useEffect, useRef, useState, type RefObject } from "react";

function hasSelection(element: HTMLElement | null): boolean {
  const selection = element?.ownerDocument.defaultView?.getSelection();
  if (!element || !selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    try { if (selection.getRangeAt(index).intersectsNode(element)) return true; }
    catch { /* Source replacement may have just detached the range. */ }
  }
  return false;
}

/** Do not replace a selected snapshot or a native Find raw-text target. Source
 * appends remain readable in a stable text node while formatting is held. */
export function useMarkdownInteractionGuard(root: RefObject<HTMLDivElement>, raw: RefObject<HTMLDivElement>): { held: boolean; release: () => void } {
  const [findActive, setFindActive] = useState(false);
  const [forced, setForced] = useState(false);
  const [, selectionChanged] = useState(0);
  const selected = hasSelection(root.current);
  const previousSelection = useRef(selected);
  previousSelection.current = selected;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const selection = (): void => {
      const current = hasSelection(root.current);
      if (current || previousSelection.current) {
        previousSelection.current = current;
        setForced(false);
        selectionChanged((value) => value + 1);
      }
    };
    const key = (event: KeyboardEvent): void => {
      // Never prevent native Find. Menu-invoked browser Find cannot reliably
      // be observed by page JS and is not claimed to preserve its active hit.
      if (raw.current && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        setForced(false);
        setFindActive(true);
      } else if (event.key === "Escape") setFindActive(false);
    };
    document.addEventListener("selectionchange", selection);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("selectionchange", selection); document.removeEventListener("keydown", key, true); };
  }, [root, raw]);
  return { held: !forced && (findActive || selected), release: () => { setForced(true); setFindActive(false); } };
}
