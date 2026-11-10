import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/src/lib/capability-enablement.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { capabilityEnabledFor, setCapabilityEnabledFor } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

for (const kind of ['skill', 'mcp']) {
  test(`${kind} switches only the selected harness and survives serialization`, () => {
    const original = { id: kind, kind, enabled: true, providerIds: ['codex', 'claude-code'] };
    const disabled = JSON.parse(JSON.stringify(setCapabilityEnabledFor(original, 'codex', false)));
    assert.equal(capabilityEnabledFor(disabled, 'codex'), false);
    assert.equal(capabilityEnabledFor(disabled, 'claude-code'), true);
    assert.deepEqual(original.providerIds, ['codex', 'claude-code']);
    const enabled = setCapabilityEnabledFor(disabled, 'codex', true);
    assert.equal(capabilityEnabledFor(enabled, 'codex'), true);
    assert.equal(capabilityEnabledFor(enabled, 'claude-code'), true);
    assert.equal(enabled.providerIds.length, 2);
  });
}

test('enabling one harness does not revive globally disabled legacy targets', () => {
  const legacy = { enabled: false, providerIds: ['codex', 'claude-code'] };
  const enabled = setCapabilityEnabledFor(legacy, 'codex', true);
  assert.deepEqual(enabled.providerIds, ['codex']);
  assert.equal(capabilityEnabledFor(enabled, 'claude-code'), false);
  const disabled = setCapabilityEnabledFor(enabled, 'codex', false);
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.providerIds, []);
});
