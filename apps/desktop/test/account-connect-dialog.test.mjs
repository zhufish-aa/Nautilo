import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../src/renderer/src/features/settings/AccountConnectDialog.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function fixture(connections, locale = 'zh-CN') {
  const states = [], refs = [], added = [], selected = [], closed = [];
  let stateIndex = 0, refIndex = 0, loginCalls = 0;
  const hooks = {
    useEffect: () => {},
    useState: (initial) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: initial => refs[refIndex++] ??= { current: initial },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return require(id);
    if (id.endsWith('/i18n')) return { useI18n: () => ({ locale }) };
    if (id.endsWith('/connections')) return { useConnectionsStore: { getState: () => ({ connections }) } };
    if (id.endsWith('/bridge')) return { getBridge: () => { loginCalls++; return undefined; } };
    if (id === './account-connect') return { ACCOUNT_HARNESSES: ['codex', 'claude-code', 'antigravity'], accountHarnessName: id => id };
    return new Proxy({}, { get: (_, key) => key });
  }, module, module.exports);
  const render = () => {
    stateIndex = 0; refIndex = 0;
    return module.exports.AccountConnectDialog({ open: true, onConnected: value => added.push(value), onSelectExisting: value => selected.push(value), onOpenChange: value => closed.push(value) });
  };
  return { render, added, selected, closed, get loginCalls() { return loginCalls; } };
}
function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object') return [];
  return [node, ...elements(node.props?.children)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text(node.props?.children) : typeof node === 'string' ? node : '';
}

for (const nativeLogin of [true, undefined]) test(`an existing Antigravity connection never reports an addition (nativeLogin=${nativeLogin})`, async () => {
  const existing = { id: 'existing', name: 'Google account', kind: 'login', harness: 'antigravity', nativeLogin };
  const f = fixture([existing]);
  const button = elements(f.render()).find(node => node.type === 'button' && node.key === 'antigravity');
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = f.render();
  assert.deepEqual(f.added, []);
  assert.deepEqual(f.closed, []);
  assert.equal(f.loginCalls, 0);
  assert.match(text(tree), /本次未新增账号，也未执行登录验证/);
  const view = elements(tree).find(node => text(node) === '查看已有账号');
  view.props.onClick();
  assert.deepEqual(f.selected, [existing]);
  assert.deepEqual(f.closed, [false]);
  assert.deepEqual(f.added, []);
});

test('an existing Antigravity connection does not block choosing another account harness', () => {
  const f = fixture([{ kind: 'login', harness: 'antigravity', name: 'Google' }], 'en-US');
  const buttons = elements(f.render()).filter(node => node.type === 'button');
  buttons.find(node => node.key === 'antigravity').props.onClick();
  assert.match(text(f.render()), /No account was added or sign-in verified/);
  buttons.find(node => node.key === 'codex').props.onClick();
  assert.equal(f.loginCalls, 1);
  assert.doesNotMatch(text(f.render()), /No account was added or sign-in verified/);
  assert.deepEqual(f.added, []);
});
