const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('traecli 2.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('  acp  ACP server\n  exec  Run non-interactively'); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const log = method => fs.appendFileSync(process.env.NAUTILO_TRAE_FIXTURE_LOG, JSON.stringify({ pid: process.pid, method }) + '\n');
const result = (id, value) => emit({ id, result: value });
const update = (type, text, sessionId = 'fixture-session') => emit({ method: 'session/update', params: {
  sessionId, update: { sessionUpdate: type, content: { type: 'text', text } },
}});
let pending;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', text => {
  const { id, method, params } = JSON.parse(text);
  if (!method) return;
  log(method);
  if (method === 'initialize') {
    if (args.includes('--needs-fallback') && args.includes('serve')) {
      emit({ id, error: { code: -32601, message: 'Use --acp' } });
    } else result(id, { protocolVersion: 1 });
  } else if (method === 'session/load' || method === 'session/new') {
    if (method === 'session/load') update('agent_message_chunk', 'REPLAYED HISTORY MUST NOT APPEAR');
    result(id, { sessionId: 'fixture-session' });
  } else if (method === 'session/prompt') {
    const prompt = params.prompt.map(item => item.text).join('');
    update('agent_message_chunk', 'OTHER SESSION MUST NOT APPEAR', 'other-session');
    update('agent_thought_chunk', 'thought:' + prompt);
    update('agent_message_chunk', 'reply:' + prompt);
    if (prompt === 'hold') { pending = id; return; }
    if (prompt === 'oversized') { process.stdout.write('x'.repeat(65536)); pending = id; return; }
    result(id, { stopReason: 'end_turn' });
    update('agent_message_chunk', 'IDLE OUTPUT MUST NOT APPEAR');
  } else if (method === 'session/cancel' && pending !== undefined) {
    result(pending, { stopReason: 'cancelled' });
    pending = undefined;
  } else if (id !== undefined) {
    emit({ id, error: { code: -32601, message: 'Unsupported test method ' + method } });
  }
});
