import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('turn summary displays generation, completion, elapsed time, and its expansion control', () => {
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
  const live = renderToStaticMarkup(view('running', null));
  assert.match(live, /执行中/);
  assert.match(live, /aria-expanded="true"/);
  assert.match(live, /conversation-wait-orbit/);

  expanded = false;
  const collapsed = view('completed', 72_000);
  const markup = renderToStaticMarkup(collapsed);
  assert.match(markup, /已完成，用时 1分12秒/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /conversation-wait-orbit/);
  const button = React.Children.only(React.Children.only(collapsed.props.children).props.children);
  button.props.onClick();
  assert.match(renderToStaticMarkup(view('completed', 72_000)), /aria-expanded="true"/);
  assert.match(renderToStaticMarkup(view('cancelled', 500)), /已停止，用时 不到1秒/);
  assert.doesNotMatch(renderToStaticMarkup(view('completed', null)), /用时/);
  const statusOnly = renderToStaticMarkup(exports.ConversationTurnView({
    turn: { status: 'completed', durationMs: 5900 }, expanded: false,
  }));
  assert.match(statusOnly, /class="conversation-process-label"/);
  assert.match(statusOnly, /已完成，用时 5秒/);
  assert.doesNotMatch(statusOnly, /<button|aria-expanded|conversation-turn-chevron/);

  for (const toolName of ['web_search', 'browser_run', 'read_file', 'write_file', 'run_code', 'agenthub_workflow_status']) {
    assert.equal(exports.isTurnTraceStep({ data: { kind: 'tool_activity', toolName } }), true, toolName);
  }
  assert.equal(exports.isTurnTraceStep({ data: { kind: 'tool_activity', subagent: {} } }), false);
  assert.equal(exports.isTurnTraceStep({ data: { kind: 'message' } }), false);
});
