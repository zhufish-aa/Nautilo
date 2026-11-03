import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/renderer/src/lib/terminal-window.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { terminalWindowStart } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
test('terminal tail remains bounded for long output without removing history', () => {
  assert.equal(terminalWindowStart(0, 500), 0);
  assert.equal(terminalWindowStart(499, 500), 0);
  assert.equal(terminalWindowStart(50000, 500), 49500);
  assert.equal(terminalWindowStart(50000, 1000), 49000);
  assert.equal(terminalWindowStart(50000, 60000), 0);
});
test('append preserves absolute row keys while earlier rows stay explicitly loadable', () => {
  assert.equal(terminalWindowStart(501, 500), 1);
  assert.equal(terminalWindowStart(502, 500), 2);
  assert.equal(terminalWindowStart(502, 1000), 0);
});
