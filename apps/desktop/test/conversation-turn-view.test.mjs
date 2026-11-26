import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('only settled process turns display a summary with elapsed time and an expansion control', () => {
  const require = createRequire(import.meta.url);
  const modules = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    'lucide-react': { Check: () => null, ChevronRight: () => null, CircleAlert: () => null, Square: () => null },
    '../../lib/i18n': { useI18n: () => ({ locale: 'zh-CN' }) }
  };
  const source = readFileSync(new URL('../src/renderer/src/features/timeline/ConversationTurnView.tsx', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: name => modules[name] });
  let expanded = true;
  const toggle = () => { expanded = !expanded; };
  const view = (status, durationMs) => exports.ConversationTurnView({ turn: { status, durationMs }, expanded, onToggle: toggle });
  assert.equal(view('running', null), null);

  expanded = false;
  const collapsed = view('completed', 72_000);
  const markup = renderToStaticMarkup(collapsed);
  assert.match(markup, /已完成，用时 1分12秒/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /conversation-wait-orbit/);
  const button = React.Children.only(React.Children.only(collapsed.props.children).props.children);
  button.props.onClick();
  assert.match(renderToStaticMarkup(view('completed', 72_000)), /aria-expanded="true"/);
  assert.match(renderToStaticMarkup(view('cancelled', 500)), /已中断，用时 不到1秒/);
  assert.match(renderToStaticMarkup(view('failed', 2900)), /执行异常，用时 2秒/);
  assert.doesNotMatch(renderToStaticMarkup(view('completed', null)), /用时/);
});
