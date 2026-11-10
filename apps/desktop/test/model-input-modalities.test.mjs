import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/renderer/src/features/agents/model-editor.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { modelRow, serializeModels } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
test('image input survives edit/save, and switching off persists text-only', () => {
  const row = modelRow({ id: 'vision', reasoningEfforts: ['high'], inputModalities: ['text', 'image'] }, 'vision');
  assert.deepEqual(serializeModels([row])[0].inputModalities, ['text', 'image']);
  assert.deepEqual(serializeModels([{ ...row, inputModalities: ['text'] }])[0].inputModalities, ['text']);
  assert.deepEqual(modelRow({ id: 'legacy', reasoningEfforts: [] }, 'legacy').inputModalities, ['text']);
});
