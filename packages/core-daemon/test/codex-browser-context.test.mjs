import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexTurnStartParams } from '../dist/adapters/codex/app-server-run.js';

const request = { instance: { providerId: 'codex', providerOptions: {} }, prompt: '使用 Nautilo 浏览器打开网页', cwd: process.cwd() };

test('Nautilo browser identity travels as application context on resumed turns, without changing user text or native instructions', () => {
  const params = buildCodexTurnStartParams({ ...request, mcpServers: [{
    name: 'nautilo_browser_', transport: 'http', desktopBrowser: true,
    url: 'http://127.0.0.1:12345/mcp/private-session', headers: { Authorization: 'Bearer private-key' }
  }] }, 'existing-thread');
  assert.equal(params.threadId, 'existing-thread');
  assert.equal(params.input[0].text, request.prompt);
  assert.equal(Object.hasOwn(params, 'developerInstructions'), false);
  assert.equal(Object.hasOwn(params, 'baseInstructions'), false);
  const context = params.additionalContext['nautilo.desktop_browser'];
  assert.equal(context.kind, 'application');
  assert.match(context.value, /nautilo_browser_/);
  assert.match(context.value, /browser_run/);
  assert.doesNotMatch(context.value, /private-key|private-session|12345/);
});

test('an unrelated MCP server does not claim that Nautilo browser tools are present', () => {
  for (const mcpServers of [undefined, [], [{ name: 'other', transport: 'http', url: 'https://example.com' }]]) {
    assert.equal(Object.hasOwn(buildCodexTurnStartParams({ ...request, mcpServers }, 'thread'), 'additionalContext'), false);
  }
});
