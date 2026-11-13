import type { CancellationToken, IDisposable, editor } from "monaco-editor";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IDiffProviderFactoryService } from "monaco-editor/editor/browser/widget/diffEditor/diffProviderFactoryService.js";

interface DiffOptions { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }
interface DiffResult { changes: unknown[]; moves: unknown[]; identical: boolean; quitEarly: boolean }
type ComputeDiff = (original: editor.ITextModel, modified: editor.ITextModel, options: DiffOptions, token: CancellationToken) => Promise<DiffResult | null>;
type ErrorListener = (error: string, original: editor.ITextModel) => void;
interface NativeDiffProvider { computeDiff: ComputeDiff; onDidChange: (listener: () => void) => IDisposable; setOptions?: (options: unknown) => void; dispose: () => void }
interface DiffFactory { createDiffProvider: (options: unknown) => NativeDiffProvider }
const recoveryKey = Symbol.for("nautilo.monaco.diff-recovery");
type RecoveryFactory = DiffFactory & { [recoveryKey]?: WeakMap<editor.ITextModel, ErrorListener> };

/** Decorate the native provider factory, not the global exception handler.
 * Monaco's public algorithm option rejects custom objects; this versioned
 * service seam retains its own algorithm, events, ranges, and cancellation. */
export function bindDiffRecovery(model: editor.ITextModel, listener: ErrorListener): IDisposable {
  const factory = StandaloneServices.get(IDiffProviderFactoryService) as RecoveryFactory;
  if (!factory[recoveryKey]) {
    const owners = new WeakMap<editor.ITextModel, ErrorListener>();
    const create = factory.createDiffProvider.bind(factory);
    factory[recoveryKey] = owners;
    const createWithRecovery = (options: unknown): NativeDiffProvider => {
      const native = create(options);
      const recovery = createResilientDiffProvider((error, original) => owners.get(original)?.(error, original), native.computeDiff.bind(native));
      return { onDidChange: native.onDidChange, computeDiff: (original, modified, options, token) =>
        owners.has(original) ? recovery.computeDiff(original, modified, options, token) : native.computeDiff(original, modified, options, token),
        setOptions: options => native.setOptions?.(options), dispose() { recovery.dispose(); native.dispose(); } };
    };
    // Delayed Monaco services cache bound methods on the proxy target. Plain
    // assignment changes the backing service but leaves that cached method in
    // place. Define the target property so existing injected references see it.
    Object.defineProperty(factory, "createDiffProvider", { value: createWithRecovery, configurable: true, writable: true });
  }
  const owners = factory[recoveryKey]!;
  owners.set(model, listener);
  return { dispose() { owners.delete(model); } };
}

/** Keep Monaco's worker path, but recover a missing worker model from the same
 * request's text snapshot. A failed diff must never masquerade as equal files
 * or turn an otherwise usable editor into an application-wide fatal overlay. */
export function createResilientDiffProvider(onError: ErrorListener, compute: ComputeDiff) {
  let disposed = false;
  const canceled = (): Error => Object.assign(new Error("Canceled"), { name: "Canceled" });
  return {
    dispose(): void { disposed = true; },
    async computeDiff(original: editor.ITextModel, modified: editor.ITextModel, options: DiffOptions, token: CancellationToken): Promise<DiffResult> {
      const active = (): boolean => !disposed && !token.isCancellationRequested && !original.isDisposed() && !modified.isDisposed();
      if (!active()) throw canceled();
      // Capture before awaiting: the view model applies edits made while a
      // request is pending. Reading newer text in the fallback applies them twice.
      const before = original.getLinesContent(), after = modified.getLinesContent();
      try {
        let result: DiffResult | null = null;
        try {
          result = await compute(original, modified, options, token);
        } catch (error) {
          if (!active()) throw canceled();
          // A broken worker transport is recoverable using Monaco's own
          // advanced algorithm; keep the user's complete models and draft.
          console.warn("Monaco diff worker unavailable; computing from the editor snapshot:", error instanceof Error ? error.message : String(error));
        }
        if (!active()) throw canceled();
        if (!result) {
          const { DefaultLinesDiffComputer } = await import("monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js");
          if (!active()) throw canceled();
          const fallback = new DefaultLinesDiffComputer().computeDiff(before, after, {
            ...options, maxComputationTimeMs: Math.min(options.maxComputationTimeMs || 75, 75)
          });
          result = { changes: fallback.changes, moves: fallback.moves, quitEarly: fallback.hitTimeout,
            identical: before.length === after.length && before.every((line, index) => line === after[index]) };
        }
        onError("", original);
        return result;
      } catch (error) {
        if (active()) onError(error instanceof Error ? error.message : String(error), original);
        // Monaco explicitly handles cancellation. The visible, local failure
        // above offers retry without inventing a successful empty diff.
        throw canceled();
      }
    }
  };
}
