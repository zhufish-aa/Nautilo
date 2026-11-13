import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
let locale = 'zh-CN';
let catalog = [];
function load(path, dependencies) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: dependencies });
  return exports;
}
const { permissionModesFor } = load('../src/renderer/src/lib/provider-catalog.ts', () => ({
  useProvidersStore: { getState: () => ({ catalog }) },
}));
const { PermissionModeSelect } = load('../src/renderer/src/features/sessions/PermissionModeSelect.tsx', name => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsx;
  if (name === '@radix-ui/react-select') return require(name);
  if (name === 'lucide-react') return Object.fromEntries(['Check', 'ChevronDown', 'Hand', 'ListChecks', 'ShieldCheck', 'ShieldAlert'].map(key => [key, () => null]));
  if (name.endsWith('/i18n')) return { useI18n: () => ({ locale }) };
  return {};
});
const render = options => renderToStaticMarkup(React.createElement(PermissionModeSelect, {
  options, value: options[0].value, onChange() {},
}));

test('permission menus render older plugin options without descriptions or complete translations', () => {
  for (locale of ['zh-CN', 'en-US']) {
    assert.doesNotThrow(() => render([{ value: 'default', name: { 'zh-CN': '请求批准' } }]));
    assert.match(render([{ value: 'native-mode' }]), /native-mode/);
    assert.match(render([{ value: 'plan', name: { 'en-US': 'Planning' } }]), /Planning/);
  }
});

test('all permission consumers receive usable localized fields from incomplete plugin catalogs', () => {
  const original = { value: 'plan', name: { 'en-US': 'Planning' } };
  catalog = [{ providerId: 'old-plugin', permissionModes: [original, { value: 'custom' }, null, { value: '' }] }];
  const options = permissionModesFor('old-plugin');
  assert.equal(options.length, 2);
  assert.equal(options[0].name['zh-CN'], 'Planning');
  assert.equal(options[0].description['zh-CN'], '');
  assert.equal(options[1].name['en-US'], 'custom');
  assert.equal(original.description, undefined, 'the source catalog is not mutated');
  assert.equal(permissionModesFor('missing').length, 0);
});

test('Antigravity declares both name and description for each supported UI locale', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../rust/plugins/antigravity/agenthub-plugin.json', import.meta.url), 'utf8'));
  for (const mode of manifest.descriptor.permissionModes) {
    for (const key of ['zh-CN', 'en-US']) {
      assert.equal(typeof mode.name[key], 'string');
      assert.equal(typeof mode.description[key], 'string');
      assert.ok(mode.description[key].length > 0);
    }
  }
});
