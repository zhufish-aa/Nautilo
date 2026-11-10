// Opt-in integration test against an installed official dsh CLI. No real key
// or model endpoint is used; all native state belongs to a temporary DSH_HOME.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
const executable = process.env.NAUTILO_DEEPSEEK_TEST_PLUGIN;
const dsh = process.env.NAUTILO_DEEPSEEK_TEST_CLI;
if (!executable || !dsh) throw new Error('Set NAUTILO_DEEPSEEK_TEST_PLUGIN and NAUTILO_DEEPSEEK_TEST_CLI');
const root = await mkdtemp(join(tmpdir(), 'nautilo-deepseek-test-'));
const workspace = join(root, 'workspace'); await mkdir(workspace);
await writeFile(join(workspace, 'fixture.txt'), 'native-tool-confirmed');
const pngChunk = (type, data) => {
  const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, payload, checksum]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr[8] = 8; ihdr[9] = 2;
const pixels = Buffer.alloc(16 * 49, 240); for (let row = 0; row < 16; row++) pixels[row * 49] = 0;
await writeFile(join(workspace, 'fixture.png'), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]));
const profilePath = join(root, 'home', 'profiles', 'web');
await mkdir(profilePath, { recursive: true });
// Exercise merging a real native profile, including its valid nullable off
// level. An empty profile misses the frozen-snapshot revalidation regression.
const nativeProviderPatch = { id: 'llm-pi-ai', config: { providers: { 'existing-native': {
  api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1',
  models: [{ id: 'existing-native-model', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }]
} } } };
await writeFile(join(profilePath, 'cordis.patch.yml'), JSON.stringify([nativeProviderPatch]));
const requests = [];
const timings = {}; let currentRun;
let warmHostRequested = false;
let fileToolRequested = false;
let hostToolRequested = false;
let codeRequested = false;
let sandboxListRequested = false;
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'nautilo-test' }] })); return; }
  const body = JSON.parse(text); requests.push(body);
  if (body.stream && currentRun && timings[currentRun].requestMs === undefined) timings[currentRun].requestMs = Math.round(performance.now() - timings[currentRun].start);
  assert.equal(req.headers.authorization, 'Bearer fake-nautilo-test-key');
  const messages = body.messages ?? [];
  const step = requests.length;
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `r${step}`, model: 'nautilo-test', choices: [{ message: { role: 'assistant', content: 'Native test title' }, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = delta => res.write(`data: ${JSON.stringify({ id: `r${step}`, model: 'nautilo-test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  chunk({ role: 'assistant', reasoning_content: 'Thinking about the native test. ' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  if (JSON.stringify(lastUser).includes('CANCEL_WARM_TURN') || JSON.stringify(lastUser).includes('TIMEOUT_WARM_TURN')) return;
  const read = body.tools?.find(tool => tool.function.name === 'read');
  const host = body.tools?.find(tool => tool.function.name === 'nautilo_test_echo');
  const codeTool = body.tools?.find(tool => tool.function.name === 'run_code');
  let tool;
  if (codeTool && !sandboxListRequested && messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('LIST_WINDOWS_WORKSPACE'))) {
    sandboxListRequested = true;
    tool = { id: 'sandbox_list', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({
      description: 'Check workspace limits', code: 'const r = await tools.pwsh({description:"Check workspace access",command:"Get-ChildItem -Name; try { Set-Content -LiteralPath ../outside-probe.txt -Value probe -ErrorAction Stop; Write-Output OUTSIDE_ALLOWED } catch { Write-Output OUTSIDE_DENIED }"}); console.log(r.kind === "foreground" ? r.stdout.text : JSON.stringify(r));'
    }) } };
  } else if (read && !fileToolRequested) {
    fileToolRequested = true;
    const property = Object.keys(read.function.parameters.properties).find(name => /path|file/.test(name));
    tool = { id: 'native_read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ [property]: join(workspace, 'fixture.txt') }) } };
  } else if (host && (!hostToolRequested || (!warmHostRequested && JSON.stringify(messages).includes('WARM_HOST_TEST')))) {
    if (hostToolRequested) warmHostRequested = true;
    hostToolRequested = true;
    tool = { id: 'host_echo', type: 'function', function: { name: 'nautilo_test_echo', arguments: '{}' } };
  } else if (codeTool && !codeRequested) {
    codeRequested = true;
    tool = { id: 'ptc_batch', type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ description: 'Read fixtures and call the host tool',
      code: `console.log(await tools.read({file_path:${JSON.stringify(join(workspace, 'fixture.txt'))}}));\nconsole.log(await tools.nautilo_test_echo({}));\nconsole.log(await tools.read_image({file_path:${JSON.stringify(join(workspace, 'fixture.png'))}}));` }) } };
  }
  if (tool) {
    chunk({ tool_calls: [{ index: 0, ...tool }] });
    res.end(`data: ${JSON.stringify({ id: `r${step}`, model: 'nautilo-test', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
    return;
  }
  const malformed = messages.some(message => typeof message.content === 'string' && message.content.includes('MALFORMED_PTC_TEST'));
  chunk({ content: malformed ? '<｜DSML｜invoke name="run_code"><｜DSML｜parameter name="code" string="true">throw new Error("should not execute");</｜DSML｜parameter></｜DSML｜invoke>' : 'NATIVE_OK' });
  res.end(`data: ${JSON.stringify({ id: `r${step}`, model: 'nautilo-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NAUTILO_DSH_TIMING: '1' } });
const childExit = once(child, 'exit');
const hostToolRuns = [];
const frames = [];
const waiting = new Set();
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
createInterface({ input: child.stdout }).on('line', line => {
  const frame = JSON.parse(line); frames.push(frame);
  if (frame.event?.kind === 'message' && frame.event.phase === 'delta' && timings[frame.runId]?.firstTextMs === undefined) timings[frame.runId].firstTextMs = Math.round(performance.now() - timings[frame.runId].start);
  if (frame.type === 'tool_call') hostToolRuns.push(frame.runId);
  if (frame.type === 'tool_call') send({ type: 'tool_response', id: frame.id, result: { success: true, content: 'HOST_TOOL_OK' } });
  if (frame.type === 'interaction') {
    const folderGrant = frame.input?.options?.some(option => option.id === 'authorize-workspace');
    const optionId = folderGrant ? (frame.runId === 'acl-deny' ? 'reject' : 'authorize-workspace') : 'once';
    send({ type: 'interaction_response', id: frame.id, response: { outcome: 'selected', optionId } });
  }
  for (const check of [...waiting]) check();
});
const send = frame => {
  if (frame.type === 'start') { currentRun = frame.runId; timings[currentRun] = { start: performance.now() }; }
  child.stdin.write(JSON.stringify(frame) + '\n');
};
const wait = predicate => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { waiting.delete(check); reject(new Error('Native test timeout: ' + stderr.slice(-500))); }, 90000);
  const check = () => { const found = frames.find(predicate); if (found) { clearTimeout(timeout); waiting.delete(check); resolve(found); } };
  waiting.add(check); check();
});
const base = { instance: { providerId: 'deepseek', executable: dsh, baseArgs: [], providerOptions: { runtimeConnectionId: 'test', runtimeConnectionRevision: 1,
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiType: 'openai-completions' }, models: [{ id: 'nautilo-test', enabled: true, reasoningEfforts: ['low', 'high'] }] },
  cwd: workspace, localSessionId: 'native-smoke', model: 'nautilo-test', reasoningEffort: 'high', agentMode: 'standard', permissionMode: 'workspace-write',
  env: { DSH_HOME: join(root, 'home'), NAUTILO_CONNECTION_API_KEY: 'fake-nautilo-test-key' }, timeoutMs: 90000 };
base.runtimeTools = [{ name: 'nautilo_test_echo', description: 'Return the test fixture receipt', inputSchema: { type: 'object', properties: {} } }];
async function assertWorkspace(folder, sessionId) {
  const registry = JSON.parse(await readFile(join(base.env.DSH_HOME, 'storages', 'workspace.json'), 'utf8'));
  const canonical = await realpath(folder);
  const memberships = Object.entries(registry.tables.workspaces).filter(([, item]) => item.sessionIds.includes(sessionId));
  assert.equal(memberships.length, 1, 'the native session belongs to exactly one workspace');
  assert.ok(registry.global.workspaceIds.includes(memberships[0][0]));
  assert.equal(relative(canonical, await realpath(memberships[0][1].path)), '');
}
try {
  send({ type: 'handshake', apiVersion: 1 }); await wait(f => f.type === 'ready');
  let session;
  for (const runId of ['first', 'second']) {
    send({ type: 'start', runId, resume: session, request: { ...base, reasoningEffort: runId === 'first' ? 'high' : 'low', permissionMode: runId === 'first' ? 'workspace-write' : 'danger-full-access', prompt: runId === 'first' ? 'Remember ORANGE_42. Say hi.' : 'What did I ask you to remember? WARM_HOST_TEST' } });
    if (runId === 'first') setTimeout(() => send({ type: 'call', id: 11, method: 'steer', input: { runId, input: 'STEER_NATIVE_MARKER' } }), 100);
    const done = await wait(f => f.type === 'event' && f.runId === runId && f.event.kind === 'exit');
    const events = frames.filter(f => f.type === 'event' && f.runId === runId).map(f => f.event);
    if (done.event.exitCode !== 0) console.log(events.filter(e => ['error', 'raw'].includes(e.kind)).slice(-10));
    assert.equal(done.event.exitCode, 0);
    const id = events.find(e => e.kind === 'session')?.providerSessionId;
    assert.ok(id); if (session) assert.equal(id, session); session = id;
    await assertWorkspace(workspace, session);
    assert.ok(events.some(e => e.kind === 'message' && e.phase === 'delta' && e.text.includes('NATIVE_OK')));
    assert.equal(events.filter(e => e.kind === 'message' && e.phase === 'completed' && e.text.includes('NATIVE_OK')).length, 1, 'every streamed reply needs one durable completion event');
    assert.ok(events.some(e => e.kind === 'thinking' && e.text?.includes('Thinking')));
    assert.ok(events.some(e => e.kind === 'usage'));
  }
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('ORANGE_42') && JSON.stringify(r.messages).includes('What did I ask')));
  assert.ok(requests.some(r => r.reasoning_effort === 'high'));
  assert.ok(requests.some(r => r.reasoning_effort === 'low'), 'warm turns apply changed reasoning effort');
  assert.ok(hostToolRuns.includes('first') && hostToolRuns.includes('second'), 'host tools must be routed to the current run after reuse');
  const diagnostics = () => stderr.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return {}; } }).filter(item => item.deepseekRuntime);
  assert.equal(diagnostics()[0]?.deepseekRuntime, 'started');
  assert.equal(diagnostics()[1]?.deepseekRuntime, 'reused');
  assert.equal(diagnostics()[0]?.pid, diagnostics()[1]?.pid, 'the second turn must use the same native process');
  const updated = { ...base, instance: { ...base.instance, providerOptions: { ...base.instance.providerOptions, runtimeConnectionRevision: 2 } } };
  send({ type: 'start', runId: 'changed', resume: session, request: { ...updated, prompt: 'Use the updated connection.' } });
  const changed = await wait(f => f.type === 'event' && f.runId === 'changed' && f.event.kind === 'exit');
  assert.equal(changed.event.exitCode, 0);
  assert.equal(diagnostics()[2]?.deepseekRuntime, 'started', 'a changed connection must rebuild the native configuration');
  assert.notEqual(diagnostics()[0]?.pid, diagnostics()[2]?.pid);
  send({ type: 'start', runId: 'cancel-warm', resume: session, request: { ...updated, prompt: 'CANCEL_WARM_TURN' } });
  await wait(f => f.type === 'event' && f.runId === 'cancel-warm' && f.event.kind === 'thinking' && f.event.text?.includes('Thinking'));
  send({ type: 'cancel', runId: 'cancel-warm' });
  await wait(f => f.type === 'event' && f.runId === 'cancel-warm' && f.event.kind === 'exit');
  send({ type: 'start', runId: 'after-cancel', resume: session, request: { ...updated, prompt: 'Continue after cancellation.' } });
  assert.equal((await wait(f => f.type === 'event' && f.runId === 'after-cancel' && f.event.kind === 'exit')).event.exitCode, 0);
  send({ type: 'start', runId: 'timeout-warm', resume: session, request: { ...updated, timeoutMs: 1000, prompt: 'TIMEOUT_WARM_TURN' } });
  assert.equal((await wait(f => f.type === 'event' && f.runId === 'timeout-warm' && f.event.kind === 'exit')).event.exitCode, 1);
  assert.ok(frames.some(f => f.runId === 'timeout-warm' && f.event?.kind === 'error' && f.event.message.includes('timed out')), 'reused processes still enforce the per-turn timeout');
  const guidance = await wait(f => f.type === 'response' && f.id === 11);
  assert.equal(guidance.ok, true);
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('STEER_NATIVE_MARKER')), 'guidance during native startup must reach the same conversation');
  assert.ok(fileToolRequested && hostToolRequested, 'native and Nautilo tools remain available');
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('native-tool-confirmed')));
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('HOST_TOOL_OK')));
  await writeFile(join(profilePath, 'cordis.patch.yml'), JSON.stringify([nativeProviderPatch, { insert: [{ id: 'preset-custom-test', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'custom-test', name: 'Custom test mode', order: 9,
    plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'CUSTOM_PRESET_TOKEN', complete: true } }] } }] }]));
  send({ type: 'call', id: 99, method: 'listModes', input: { instance: { providerId: 'deepseek', executable: dsh }, context: { env: base.env, cwd: workspace } } });
  const modes = await wait(f => f.type === 'response' && f.id === 99);
  assert.equal(modes.ok, true);
  assert.ok(modes.data.modes.some(mode => mode.id === 'custom-test' && mode.name === 'Custom test mode'));
  send({ type: 'start', runId: 'custom', request: { ...base, localSessionId: 'custom-mode', agentMode: 'custom-test', prompt: 'Use the custom mode.' } });
  const custom = await wait(f => f.type === 'event' && f.runId === 'custom' && f.event.kind === 'exit');
  if (custom.event.exitCode !== 0) console.log(frames.filter(f => f.runId === 'custom' && ['error', 'raw'].includes(f.event?.kind)).slice(-8));
  assert.equal(custom.event.exitCode, 0);
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('CUSTOM_PRESET_TOKEN')), 'selected custom preset must reach native prompt composition');
  const vision = { ...base.instance.models[0], inputModalities: ['text', 'image'] };
  send({ type: 'start', runId: 'ptc', request: { ...base, instance: { ...base.instance, models: [vision] }, localSessionId: 'ptc-mode', agentMode: 'ptc', permissionMode: 'danger-full-access', prompt: 'Execute the PTC batch.' } });
  const ptc = await wait(f => f.type === 'event' && f.runId === 'ptc' && f.event.kind === 'exit');
  const ptcEvents = frames.filter(f => f.runId === 'ptc' && f.type === 'event').map(f => f.event);
  if (ptc.event.exitCode !== 0 || !ptcEvents.some(e => e.kind === 'tool' && e.phase === 'completed' && e.success === true)) console.log(ptcEvents.filter(e => ['error', 'tool'].includes(e.kind)));
  assert.equal(ptc.event.exitCode, 0);
  assert.ok(codeRequested);
  const completedBatch = ptcEvents.find(e => e.kind === 'tool' && e.name === 'run_code' && e.phase === 'completed');
  assert.equal(completedBatch?.success, true, completedBatch?.output);
  const dispatches = new Map();
  for (const event of ptcEvents) for (const call of event.raw?.codeExecution?.calls ?? []) {
    dispatches.set(call.callId, { ...dispatches.get(call.callId), ...call });
  }
  assert.equal(dispatches.size, 3);
  assert.ok([...dispatches.values()].every(call => call.status === 'done'));
  assert.ok([...dispatches.values()].every(call => call.parentCallId && call.input));
  assert.equal(ptcEvents.find(e => e.name === 'run_code' && e.phase === 'started').raw.codeExecution.description, 'Read fixtures and call the host tool');
  assert.ok(ptcEvents.some(e => e.phase === 'updated' && e.raw?.codeExecution?.calls.some(call => call.status === 'running')));
  assert.ok(requests.some(r => JSON.stringify(r.messages).includes('image_url')), 'declared image input must reach the model');
  assert.ok(ptcEvents.findIndex(e => e.kind === 'exit') > ptcEvents.indexOf(completedBatch), 'run completion must follow the batch result');
  send({ type: 'start', runId: 'malformed', request: { ...base, localSessionId: 'malformed-mode', agentMode: 'ptc', prompt: 'MALFORMED_PTC_TEST' } });
  const malformed = await wait(f => f.type === 'event' && f.runId === 'malformed' && f.event.kind === 'exit');
  assert.equal(malformed.event.exitCode, 1, 'unexecuted DSML must not appear as a successful run');
  assert.ok(!frames.some(f => f.runId === 'malformed' && f.event?.kind === 'tool'), 'never execute tool-looking assistant text');
  const other = join(root, 'other-workspace');
  await mkdir(other);
  const callsBeforeMismatch = requests.length;
  send({ type: 'start', runId: 'wrong-folder', resume: session, request: { ...base, cwd: other, prompt: 'Wrong folder' } });
  assert.equal((await wait(f => f.type === 'event' && f.runId === 'wrong-folder' && f.event.kind === 'exit')).event.exitCode, 1);
  assert.equal(requests.length, callsBeforeMismatch, 'a resume in another project must stop before inference');
  send({ type: 'start', runId: 'other', request: { ...base, cwd: other, localSessionId: 'other-project', prompt: 'Use the second project' } });
  send({ type: 'start', runId: 'parallel', request: { ...base, localSessionId: 'parallel-project', prompt: 'Use the original project' } });
  assert.equal((await wait(f => f.type === 'event' && f.runId === 'other' && f.event.kind === 'exit')).event.exitCode, 0);
  assert.equal((await wait(f => f.type === 'event' && f.runId === 'parallel' && f.event.kind === 'exit')).event.exitCode, 0);
  const otherSession = frames.find(f => f.runId === 'other' && f.event?.kind === 'session').event.providerSessionId;
  const parallelSession = frames.find(f => f.runId === 'parallel' && f.event?.kind === 'session').event.providerSessionId;
  await assertWorkspace(workspace, parallelSession);
  await assertWorkspace(other, otherSession);
  await assertWorkspace(workspace, session);
  if (process.platform === 'win32') {
    const folder = join(root, 'requires-authorization');
    await mkdir(folder);
    const marker = 'workspace-permission-ok.txt';
    await writeFile(join(folder, marker), '');
    const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-[0-9-]+/)[0];
    execFileSync('icacls.exe', [folder, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)M', '/grant', '*' + sid + ':(WDAC)'], { windowsHide: true });
    const run = async (runId, permissionMode, prompt) => {
      send({ type: 'start', runId, request: { ...base, localSessionId: runId, cwd: folder, agentMode: 'ptc', permissionMode, prompt } });
      return (await wait(f => f.type === 'event' && f.runId === runId && f.event.kind === 'exit')).event.exitCode;
    };
    const before = requests.length;
    assert.equal(await run('acl-deny', 'workspace-write', 'Refuse the grant'), 1);
    assert.equal(requests.length, before);
    assert.equal(await run('acl-read', 'read-only', 'Read only'), 0);
    assert.equal(await run('acl-full', 'danger-full-access', 'Full access'), 0);
    assert.equal(await run('acl-allow', 'workspace-write', 'LIST_WINDOWS_WORKSPACE'), 0);
    assert.ok(requests.some(r => r.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes(marker))), 'the real confined PowerShell tool must list the project file');
    assert.ok(requests.some(r => r.messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('OUTSIDE_DENIED'))));
    await assert.rejects(readFile(join(root, 'outside-probe.txt')), { code: 'ENOENT' });
    assert.equal(await run('acl-reuse', 'workspace-write', 'Use the authorized workspace'), 0);
    const grants = frames.filter(f => f.type === 'interaction' && f.runId.startsWith('acl-') && f.input.options?.some(o => o.id === 'authorize-workspace'));
    assert.deepEqual(grants.map(f => f.runId), ['acl-deny', 'acl-allow']);
  }
  console.log(JSON.stringify({ ok: true, requests: requests.length, session, root, timings: Object.fromEntries(Object.entries(timings).map(([run, { start, ...timing }]) => [run, timing])), runtimes: diagnostics() }));
} finally {
  child.stdin.end();
  const forceStop = setTimeout(() => child.kill(), 15000);
  await childExit; clearTimeout(forceStop);
  server.closeAllConnections(); server.close();
}
