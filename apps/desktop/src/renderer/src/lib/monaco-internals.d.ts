// Narrow typings for the Monaco 0.56 provider-factory recovery seam.
// All algorithms and range mappings still come from Monaco itself.
declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: { get(service: unknown): unknown };
}
declare module "monaco-editor/editor/browser/widget/diffEditor/diffProviderFactoryService.js" {
  export const IDiffProviderFactoryService: unknown;
}
declare module "monaco-editor/editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js" {
  export class DefaultLinesDiffComputer {
    computeDiff(original: string[], modified: string[], options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }): { changes: unknown[]; moves: unknown[]; hitTimeout: boolean };
  }
}
