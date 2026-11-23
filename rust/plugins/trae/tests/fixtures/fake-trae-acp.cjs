const fs = require('node:fs');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('traecli 2.0.0'); process.exit(0); }
if (args.includes('--help')) { console.log('  acp  ACP server\n  exec  Run non-interactively'); process.exit(0); }
const emit = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const log = method => fs.appendFileSync(process.env.NAUTILO_TRAE_FIXTURE_LOG, JSON.stringify({ pid: process.pid, method }) + '\n');
const result = (id, value) => emit({ id, result: value });
const notify = (update, sessionId = 'fixture-session') => emit({ method: 'session/update', params: {
  sessionId, update,
}});
const update = (type, text, sessionId) => notify({ sessionUpdate: type, content: { type: 'text', text } }, sessionId);
let pending;
let mcpServers;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async text => {
  const { id, method, params } = JSON.parse(text);
  if (!method) return;
  log(method);
  if (method === 'initialize') {
    if (args.includes('--needs-fallback') && args.includes('serve')) {
      emit({ id, error: { code: -32601, message: 'Use --acp' } });
    } else result(id, { protocolVersion: 1 });
  } else if (method === 'session/load' || method === 'session/new') {
    mcpServers = params.mcpServers;
    if (method === 'session/load') update('agent_message_chunk', 'REPLAYED HISTORY MUST NOT APPEAR');
    result(id, { sessionId: 'fixture-session' });
  } else if (method === 'session/prompt') {
    const prompt = params.prompt.map(item => item.text).join('');
    update('agent_message_chunk', 'OTHER SESSION MUST NOT APPEAR', 'other-session');
    if (prompt === 'runtime-tools') {
      try {
        const server = mcpServers.find(item => item.name === 'nautilo_runtime');
        assert.deepEqual(server.args, ['--local-mcp-stdio']);
        const browser = mcpServers.find(item => item.name === 'nautilo_browser');
        assert.deepEqual(browser.args, ['--local-mcp-stdio']);
        assert.equal(mcpServers.find(item => item.name === 'user_mcp').type, 'http');
        const { url } = JSON.parse(server.env.find(item => item.name === 'NAUTILO_LOCAL_MCP_SPEC').value);
        const call = async (method, params) => (await fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })).json();
        const { result: { tools } } = await call('tools/list', {});
        assert.deepEqual(tools.map(tool => tool.name), ['agenthub_delegate', 'agenthub_workflow_submit']);
        const { result: receipt } = await call('tools/call', {
          name: 'agenthub_delegate', arguments: { task: 'inspect' },
        });
        assert.equal(receipt.isError, false);
        update('agent_message_chunk', receipt.content[0].text);
      } catch (error) {
        emit({ id, error: { code: -32603, message: String(error) } });
        return;
      }
    } else if (prompt === 'first' || prompt === 'second') {
      const toolCallId = 'read:' + prompt;
      update('agent_thought_chunk', '');
      update('agent_thought_chunk', 'before:' + prompt);
      update('agent_thought_chunk', ' one');
      notify({ sessionUpdate: 'tool_call', toolCallId, title: 'Read file', status: 'in_progress', rawInput: { path: 'a.txt' } });
      update('agent_thought_chunk', 'after:' + prompt);
      notify({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', rawInput: { path: 'b.txt' } });
      update('agent_thought_chunk', ' two');
      notify({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: 'done' });
      update('agent_message_chunk', 'reply:' + prompt);
      update('agent_thought_chunk', 'more:' + prompt);
      notify({ sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', rawInput: { path: 'late.txt' } });
      update('agent_message_chunk', '');
      update('agent_thought_chunk', ' three');
    } else {
      update('agent_thought_chunk', 'thought:' + prompt);
      update('agent_message_chunk', 'reply:' + prompt);
    }
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
