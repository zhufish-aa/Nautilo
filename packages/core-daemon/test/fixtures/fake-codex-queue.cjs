// Deterministic stdio-only protocol fixture. No network, credentials or model.
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (value) => process.env.CODEX_FAKE_LOG && appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\n');
let sequence = 0;
let active;
log({ event: 'spawn' });
const finish = () => {
  if (!active) return;
  clearTimeout(active.timer);
  send({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: active.turnId, delta: `done:${active.prompt}` } });
  send({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed' } } });
  active = undefined;
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const q = JSON.parse(line); log(q);
  if (q.id === undefined || !q.method) return;
  const result = (value) => send({ id: q.id, result: value });
  if (q.method === 'initialize') return result({});
  if (q.method === 'test/crash') { result({}); setTimeout(() => process.exit(17), 0); return; }
  if (q.method === 'thread/start' || q.method === 'thread/resume') return result({ thread: { id: q.params.threadId ?? `thread-${process.pid}-${++sequence}` } });
  if (q.method === 'thread/subscribe') return result({});
  if (q.method === 'turn/start') {
    if (active) return send({ id: q.id, error: { code: -32000, message: 'Concurrent turn on shared stream' } });
    const prompt = q.params.input[0].text;
    active = { threadId: q.params.threadId, turnId: `turn-${++sequence}`, prompt };
    result({ turn: { id: active.turnId } });
    send({ method: 'turn/started', params: { threadId: active.threadId, turnId: active.turnId } });
    if (prompt === 'crash') {
      active.timer = setTimeout(() => process.exit(17), 90);
      return;
    }
    if (prompt === 'foreign') {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'previous-session', turnId: 'old', delta: 'MUST NOT LEAK' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: 'old', delta: 'MUST NOT LEAK OLD TURN' } });
      send({ id: 'stale-tool', method: 'item/tool/call', params: { threadId: active.threadId, turnId: 'old', tool: 'must_not_run', arguments: {} } });
      send({ id: 'foreign-tool', method: 'item/tool/call', params: { threadId: 'previous-session', tool: 'must_not_run', arguments: {} } });
      send({ method: 'turn/completed', params: { threadId: 'previous-session', turn: { id: 'old' } } });
    }
    if (!['hang', 'stubborn', 'no-interrupt-response', 'tool-after-interrupt', 'crash-controlled'].includes(prompt)) active.timer = setTimeout(finish, prompt === 'slow' ? 180 : 20);
    return;
  }
  if (q.method === 'turn/interrupt') {
    if (active?.prompt !== 'no-interrupt-response') result({});
    if (active?.prompt === 'tool-after-interrupt') send({ id: 'after-cancel-tool', method: 'item/tool/call', params: { threadId: active.threadId, turnId: active.turnId, tool: 'must_not_run', arguments: {} } });
    if (active?.prompt !== 'stubborn' && active?.threadId === q.params.threadId && active?.turnId === q.params.turnId) finish();
    return;
  }
  send({ id: q.id, error: { code: -32601, message: `Unexpected method ${q.method}` } });
});
