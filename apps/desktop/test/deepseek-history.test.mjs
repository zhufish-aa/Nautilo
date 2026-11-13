import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createHarness, helperModules } from './helpers/orchestration-runtime-harness.mjs';

const { recoverLegacyDeepSeekReplies } = helperModules['./deepseek-legacy-history'];
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/renderer/src/lib/conversation-timeline.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports });

function history() {
  const events = [], messages = [];
  const event = (type, runId, payload = {}, background) => {
    const sequence = events.length + 1;
    const timestamp = new Date(Date.UTC(2026, 10, 11, 16, 30, sequence)).toISOString();
    const item = { schemaVersion: 1, eventId: `e${sequence}`, sequence, timestamp, type, runId, sessionId: 's', projectId: 'p', payload, background };
    events.push(item);
    return item;
  };
  event('run.started', 'old');
  event('provider.runtime_ready', 'old', { providerId: 'deepseek', pid: 1 });
  event('run.cancelled', 'old');
  event('provider.runtime_closed', 'old', { providerId: 'deepseek', exitCode: 1 }, true);
  for (let turn = 1; turn <= 3; turn++) {
    const runId = `r${turn}`, userId = `u${turn}`;
    const start = event('run.started', runId, { userMessageId: userId });
    messages.push({ id: userId, sessionId: 's', sender: 'user', kind: 'chat', text: `question ${turn}`, createdAt: start.timestamp });
    event('provider.runtime_ready', runId, { providerId: 'deepseek', pid: 2, reused: turn > 1 });
    const nativeId = `nautilo-s:nautilo-s:${turn}:0`;
    event('agent.message_delta', 'old', { messageId: nativeId, text: `answer ${turn}` }, true);
    const reply = event('agent.message', 'old', { providerMessageId: nativeId, messageId: `a${turn}`, text: `answer ${turn}` }, true);
    messages.push({ id: `a${turn}`, sessionId: 's', sender: 'agent', kind: 'chat', text: `answer ${turn}`, runId: 'old', background: true, createdAt: reply.timestamp });
    event('run.completed', runId, { summary: 'CLI process completed' });
  }
  return { events, messages, event };
}

test('recovered DeepSeek replies follow each of three user messages after cancel/resume', () => {
  const { events, messages } = history();
  const rows = createHarness().runtime.buildStandaloneTimeline(messages, events, []);
  const bubbles = rows.filter(row => row.data.kind === 'message');
  assert.deepEqual(Array.from(bubbles, row => row.data.text), ['question 1', 'answer 1', 'question 2', 'answer 2', 'question 3', 'answer 3']);
  for (const [index, row] of bubbles.entries()) if (row.data.sender === 'agent') {
    assert.equal(row.runId, `r${(index + 1) / 2}`);
    assert.equal(row.background, undefined);
  }
  const turns = exports.conversationRows(rows, false).filter(row => row.kind === 'turn' && row.turn.result);
  assert.deepEqual(Array.from(turns, row => row.turn.result.data.text), ['answer 1', 'answer 2', 'answer 3']);
  assert.equal(events.find(event => event.type === 'agent.message').runId, 'old', 'the event journal remains immutable');
  assert.equal(messages.find(message => message.sender === 'agent').runId, 'old');
});

test('legacy recovery does not move real child output, a live old runtime, or namespaced replies', () => {
  for (const scenario of ['child', 'not-closed', 'namespaced', 'other-provider', 'after-foreground']) {
    const { events, messages } = history();
    for (const event of events) {
      if (scenario === 'not-closed' && event.type === 'provider.runtime_closed') event.type = 'provider.commands_updated';
      if (scenario === 'other-provider' && event.type === 'provider.runtime_ready') event.payload.providerId = 'other';
      if (event.type.startsWith('agent.')) {
        if (scenario === 'child') event.payload.subagentDispatchId = 'child-origin';
        if (scenario === 'namespaced') {
          if (event.payload.providerMessageId) event.payload.providerMessageId = 'nautilo-s:uuid:nautilo-s:1:0';
          else event.payload.messageId = 'nautilo-s:uuid:nautilo-s:1:0';
        }
      }
    }
    if (scenario === 'after-foreground') {
      const late = events.filter(event => event.type.startsWith('agent.'));
      for (const event of late) events.splice(events.indexOf(event), 1);
      events.push(...late);
    }
    const recovered = recoverLegacyDeepSeekReplies(messages, events);
    assert.equal(recovered.events, events, scenario);
    assert.equal(recovered.messages, messages, scenario);
  }
});
