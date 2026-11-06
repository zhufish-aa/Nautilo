import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/renderer/src/lib/provider-update-command.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { providerUpdateCommand } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

test('Codex native binary inside npm uses the owning JS entrypoint', () => {
  const executable = String.raw`C:\Users\User Name\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`;
  assert.deepEqual(providerUpdateCommand('codex', executable), {
    executable: 'node', args: ['C:/Users/User Name/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js', 'update']
  });
});
test('pnpm and older vendor layouts retain package-manager detection', () => {
  const root = '/home/user/.local/share/pnpm/global/5/node_modules/.pnpm/@openai+codex@1/node_modules/@openai/codex';
  assert.deepEqual(providerUpdateCommand('codex', `${root}/vendor/triple/bin/codex`), { executable: 'node', args: [`${root}/bin/codex.js`, 'update'] });
});
test('standalone binaries and other harnesses keep their native update commands', () => {
  assert.deepEqual(providerUpdateCommand('codex', '/opt/codex'), { executable: '/opt/codex', args: ['update'] });
  assert.deepEqual(providerUpdateCommand('claude-code', 'claude'), { executable: 'claude', args: ['update'] });
  assert.equal(providerUpdateCommand('custom-cli', 'custom'), undefined);
});
