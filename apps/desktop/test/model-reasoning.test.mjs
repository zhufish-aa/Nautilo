import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/renderer/src/lib/model-reasoning.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { withDefaultReasoning } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
test('new and discovered models receive five enabled reasoning levels', () => {
  const model = withDefaultReasoning({ id: 'new-model' });
  assert.deepEqual(model.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(model.defaultReasoningEffort, 'low');
});
test('upstream default reasoning is retained, including custom defaults', () => {
  assert.equal(withDefaultReasoning({ defaultReasoningEffort: 'high' }).defaultReasoningEffort, 'high');
  const custom = withDefaultReasoning({ defaultReasoningEffort: 'custom_7' });
  assert.equal(custom.defaultReasoningEffort, 'custom_7');
  assert.ok(custom.reasoningEfforts.includes('custom_7'));
});
