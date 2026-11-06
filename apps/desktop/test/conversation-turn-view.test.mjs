import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('process stays expanded while generating, collapses after the result, and can reopen', () => {
  const require = createRequire(import.meta.url);
  let expansion;
  const modules = {
    react: { useId: () => 'process', useState: initial => { expansion ??= initial; return [expansion, value => { expansion = value; }]; } },
    'react/jsx-runtime': require('react/jsx-runtime'),
    'lucide-react': { Bot: () => null, ChevronDown: () => null, Loader2: () => null },
    '../../lib/i18n': { useI18n: () => ({ locale: 'zh-CN' }) },
    './Timeline': { TimelineEventView: ({ event, showAuthor }) => React.createElement('div', null, showAuthor && 'Nautilo', event.data.text ?? event.data.toolName) }
  };
  const source = readFileSync(new URL('../src/renderer/src/features/timeline/ConversationTurnView.tsx', import.meta.url), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, require: name => modules[name] });
  const before = { id: 'step', data: { kind: 'message', sender: 'agent', text: 'Reading the file' } };
  const result = { id: 'result', data: { kind: 'message', sender: 'agent', text: 'Final answer' } };
  const render = turn => exports.ConversationTurnView({ turn });
  const dispatch = { id: 'native', data: { kind: 'tool_activity', toolName: 'Native child dispatch', subagent: { task: 'Read directory' }, status: 'done' } };
  const after = { id: 'after', data: { kind: 'message', sender: 'agent', text: 'Checking the delegated result' } };
  const task = { id: 'task', data: { kind: 'task_update', text: 'Team task card', status: 'running' } };
  const command = { id: 'command', data: { kind: 'tool_activity', toolName: 'Verify directory' } };
  const notice = { id: 'notice', data: { kind: 'approval', text: 'Approval needed' } };
  const turn = { id: 'turn', events: [before, dispatch, after, task, command, notice, result], completed: false };
  const assertOrder = (markup, labels) => {
    let previous = -1;
    for (const label of labels) {
      const position = markup.indexOf(label);
      assert.ok(position > previous, `${label} retains its chronological position`);
      previous = position;
    }
  };
  const live = renderToStaticMarkup(render(turn));
  assert.match(live, /Reading the file/);
  assert.match(live, /Final answer/);
  assert.match(live, /aria-expanded="true"/);
  assert.doesNotMatch(live, /assistant-identity|assistant-mark/);
  assertOrder(live, ['Reading the file', 'Native child dispatch', 'Checking the delegated result', 'Team task card', 'Verify directory', 'Approval needed', 'Final answer']);
  const done = { ...turn, completed: true, result, durationMs: 72_000 };
  const collapsed = renderToStaticMarkup(render(done));
  assert.doesNotMatch(collapsed, /Reading the file/);
  assert.match(collapsed, /Final answer/);
  assert.match(collapsed, /已完成，用时 1分12秒/);
  assert.doesNotMatch(collapsed, /项过程|assistant-identity/);
  assert.ok(collapsed.indexOf('conversation-turn-summary') < collapsed.indexOf('Final answer'));
  assert.equal((collapsed.match(/Native child dispatch/g) ?? []).length, 1, 'native delegation remains visible outside the collapsed process');
  assert.match(collapsed, /aria-expanded="false"/);
  assertOrder(collapsed, ['Native child dispatch', 'Team task card', 'Approval needed', 'Final answer']);
  const buttons = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    React.Children.forEach(node.props?.children, visit);
  };
  visit(render(done));
  buttons[0].props.onClick();
  const reopened = renderToStaticMarkup(render(done));
  assert.match(reopened, /Reading the file/);
  assert.match(reopened, /Final answer/);
  assert.match(reopened, /aria-expanded="true"/);
  assertOrder(reopened, ['Reading the file', 'Native child dispatch', 'Checking the delegated result', 'Team task card', 'Verify directory', 'Approval needed', 'Final answer']);
  const updated = { ...done, events: done.events.map(event => event === task ? { ...task, data: { ...task.data, status: 'completed' } } : event) };
  assertOrder(renderToStaticMarkup(render(updated)), ['Native child dispatch', 'Team task card', 'Verify directory', 'Final answer']);
  const plain = renderToStaticMarkup(render({ id: 'plain', events: [result], result, completed: true, durationMs: 3_000 }));
  assert.match(plain, /已完成，用时 3秒/);
  assert.match(plain, /Final answer/);
  assert.doesNotMatch(plain, /<button|aria-expanded|assistant-identity/);
  assert.match(renderToStaticMarkup(render({ ...done, durationMs: 500 })), /用时 不到1秒/);
  assert.doesNotMatch(renderToStaticMarkup(render({ ...done, durationMs: undefined })), /用时/);
  assert.match(renderToStaticMarkup(render({ ...done, events: [...done.events, { id: 'stopped', data: { kind: 'activity', phase: 'stopped' } }] })), /已停止，用时 1分12秒/);
});
