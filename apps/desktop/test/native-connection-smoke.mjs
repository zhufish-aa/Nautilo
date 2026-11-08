// Manual native integration: no user databases, accounts or paid API requests.
// NAUTILO_NATIVE_CORE=<built core exe> NAUTILO_NATIVE_PLUGINS=<cargo profile dir>
// node apps/desktop/test/native-connection-smoke.mjs [pi codex ...]
// NAUTILO_NATIVE_COMPACT=1 also verifies native /compact for Codex and DeepSeek (use Responses for DeepSeek).
// NAUTILO_NATIVE_STREAM=1 checks successive reasoning/text updates before completion.
// NAUTILO_NATIVE_TEAM=1 exercises the native main-Agent team launch and IPC liveness.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const core = process.env.NAUTILO_NATIVE_CORE;
const binaries = process.env.NAUTILO_NATIVE_PLUGINS;
if (!core || !binaries) throw Error('Set NAUTILO_NATIVE_CORE and NAUTILO_NATIVE_PLUGINS to the built executables');
const scratch = await mkdtemp(join(tmpdir(), 'nautilo-native-api-'));
const root = resolve(import.meta.dirname, '../../..');
const wanted = process.argv.slice(2);
const harnesses = wanted.length ? wanted : ['pi', 'omp', 'kimi-code', 'opencode', 'commandcode', 'codex', 'claude-code', 'trae'];
const pluginIds = ['pi', 'omp', 'opencode', 'commandcode', 'trae', 'deepseek'];
const fixtureKey = 'nautilo-fixture-key';
const model = 'deepseek/nautilo-fixture';
const effort = process.env.NAUTILO_NATIVE_EFFORT ?? 'max';
const protocol = process.env.NAUTILO_NATIVE_PROTOCOL ?? 'chat';
const verifyStream = process.env.NAUTILO_NATIVE_STREAM === '1';
const verifyTeam = process.env.NAUTILO_NATIVE_TEAM === '1';
const verifyResources = process.env.NAUTILO_NATIVE_RESOURCES === '1';
const calls = [];
const verifyDshCompact = harnesses.includes('deepseek') && protocol === 'responses' && process.env.NAUTILO_NATIVE_COMPACT === '1';
const checkpoint = 'Nautilo verified checkpoint';
let rejectDshSummary = false;
const server = createServer((request, response) => { void (async () => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  if (request.url?.endsWith('/models')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: model }] })); return; }
  if (request.url?.includes('/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ input_tokens: 20 })); return; }
  const pathname = new URL(request.url, 'http://fixture').pathname;
  const suffix = protocol === 'responses' ? '/responses' : protocol === 'anthropic' ? '/messages' : '/chat/completions';
  if (!harnesses.some(harness => pathname === `/${harness}/v1${suffix}`)) { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({error:{message:'Unexpected API route'}})); return; }
  const input = JSON.stringify(body.input ?? []);
  const dshSummary = verifyDshCompact && pathname.startsWith('/deepseek/') && input.includes('acting as a compaction engine');
  calls.push({ dshSummary, hasCheckpoint: input.includes(checkpoint), path: request.url, model: body.model, stream: body.stream, authorization: request.headers.authorization ?? `Bearer ${request.headers['x-api-key']}`, effort: body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort, hasPreviousReply: JSON.stringify(body.messages ?? body.input ?? '').includes('Nautilo API fixture OK'),
    nativeMcp: JSON.stringify(body).includes('native_fixture_echo'), managedMcp: JSON.stringify(body).includes('managed_fixture_echo'), toolNames:(body.tools??[]).map(tool=>tool.function?.name??tool.name) });
  await writeFile(join(scratch, 'calls.json'), JSON.stringify(calls.map(({authorization, ...call}) => call), null, 2));
  if (dshSummary && (rejectDshSummary || body.reasoning?.effort === 'off')) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Fixture rejected the summary request', param: 'reasoning.effort', type: 'invalid_request_error' } }));
    return;
  }
  if (verifyStream && body.stream) { await incrementalFixture(response, protocol, request.url?.includes('/trae/') && body.tools?.some(tool => (tool.function?.name ?? tool.name) === 'task_done')); return; }
  const fixtureText = dshSummary ? checkpoint : 'Nautilo API fixture OK';
  const taskDone = request.url?.includes('/trae/') && body.tools?.some(tool => (tool.function?.name ?? tool.name) === 'task_done');
  const sendEvents = events => { response.writeHead(200, { 'content-type': 'text/event-stream' }); for (const [index, event] of events.entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`); response.end(); };
  if (protocol === 'responses') {
    const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: fixtureText, annotations: [] }] };
    const result = { id: 'resp-fixture', object: 'response', created_at: 1, status: 'completed', model, output: [item, ...(taskDone ? [{ type: 'function_call', id: 'fc-done', call_id: 'done-fixture', name: 'task_done', arguments: '{}' }] : [])], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 } } };
    if (body.stream) sendEvents([
      { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: fixtureText },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: fixtureText },
      { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: result },
    ]);
    else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); }
    return;
  }
  if (protocol === 'anthropic') {
    const message = { id: 'msg-fixture', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: fixtureText }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } };
    if (taskDone) { message.content.push({ type: 'tool_use', id: 'done-fixture', name: 'task_done', input: {} }); message.stop_reason = 'tool_use'; }
    if (body.stream) sendEvents([
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fixtureText } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
    else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); }
    return;
  }
  const result = { id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'Nautilo API fixture OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_tokens_details: { cached_tokens: 0 } } };
  if (taskDone) { result.choices[0].message.tool_calls = [{ id: 'done-fixture', type: 'function', function: { name: 'task_done', arguments: '{}' } }]; result.choices[0].finish_reason = 'tool_calls'; }
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Nautilo API fixture OK', ...(taskDone ? {tool_calls: result.choices[0].message.tool_calls.map((call,index)=>({...call,index}))} : {}) }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...result, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: result.choices[0].finish_reason }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } else { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); }
})().catch(error => { response.writeHead(500); response.end(error.message); }); });

async function incrementalFixture(response, protocol, taskDone = false) {
  const thoughts = ['This is a riddle. ', 'Let me analyze. ', 'A girl scored 38.'];
  const words = ['Nautilo API ', 'fixture OK'];
  const reasoning = { id: 'rs-fixture', type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: thoughts.join('') }], encrypted_content: 'opaque-fixture' };
  const message = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: words.join(''), annotations: [] }] };
  const result = { id: 'resp-fixture', object: 'response', created_at: 1, model, status: 'completed', error: null, incomplete_details: null, output: [reasoning, message], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } } };
  let events;
  if (protocol === 'responses') events = [
    { type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, status: 'in_progress', summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, item_id: reasoning.id, summary_index: 0, part: { type: 'summary_text', text: '' } },
    ...thoughts.map(delta => ({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: reasoning.id, summary_index: 0, delta })),
    { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: reasoning.id, summary_index: 0, text: thoughts.join('') },
    { type: 'response.reasoning_summary_part.done', output_index: 0, item_id: reasoning.id, summary_index: 0, part: reasoning.summary[0] },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.output_item.added', output_index: 1, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 1, item_id: message.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    ...words.map(delta => ({ type: 'response.output_text.delta', output_index: 1, item_id: message.id, content_index: 0, delta })),
    { type: 'response.output_text.done', output_index: 1, item_id: message.id, content_index: 0, text: words.join('') },
    { type: 'response.content_part.done', output_index: 1, item_id: message.id, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.completed', response: result },
  ];
  else if (protocol === 'anthropic') events = [
    { type: 'message_start', message: { id: message.id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    ...thoughts.map(thinking => ({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })),
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-fixture' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    ...words.map(text => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })),
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  else events = [
    ...thoughts.map(reasoning_content => ({ choices: [{ index: 0, delta: { reasoning_content }, finish_reason: null }] })),
    ...words.map(content => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ];
  if (taskDone) {
    if (protocol === 'responses') {
      const item={type:'function_call',id:'fc-done',call_id:'done-fixture',name:'task_done',arguments:'{}',status:'completed'};
      result.output.push(item);
      events.splice(events.length-1,0,{type:'response.output_item.added',output_index:2,item:{...item,arguments:'',status:'in_progress'}},{type:'response.function_call_arguments.delta',output_index:2,item_id:item.id,delta:'{}'},{type:'response.function_call_arguments.done',output_index:2,item_id:item.id,arguments:'{}'},{type:'response.output_item.done',output_index:2,item});
    } else if (protocol === 'anthropic') {
      events.splice(events.length-2,0,{type:'content_block_start',index:2,content_block:{type:'tool_use',id:'done-fixture',name:'task_done',input:{}}},{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{}'}},{type:'content_block_stop',index:2});
      events.at(-2).delta.stop_reason='tool_use';
    } else {
      events.splice(events.length-1,0,{choices:[{index:0,delta:{tool_calls:[{index:0,id:'done-fixture',type:'function',function:{name:'task_done',arguments:'{}'}}]},finish_reason:null}]});
      events.at(-1).choices[0].finish_reason='tool_calls';
    }
  }
  if (process.env.NAUTILO_NATIVE_TEXT_ONLY === '1' && protocol === 'responses') {
    result.output=result.output.filter(item=>item.type!=='reasoning');
    events=events.filter(event=>!event.type.includes('reasoning') && event.item?.type!=='reasoning');
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [sequence_number, event] of events.entries()) {
    response.write(`${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify({ ...(protocol === 'chat' ? { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model } : {}), ...event, sequence_number })}\n\n`);
    if (event.type?.endsWith('.delta') || event.type === 'content_block_delta' || event.choices?.[0]?.delta?.content || event.choices?.[0]?.delta?.reasoning_content) await new Promise(resolve => setTimeout(resolve, 250));
  }
  response.end(protocol === 'chat' ? 'data: [DONE]\n\n' : '');
}
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\nautilo-native-api-${randomUUID()}` : join(scratch, 'core.sock');
const tokenPath = join(scratch, 'core.token');
const stderr = [];
const fixtureCore = join(scratch, 'nautilo-core.exe');
await copyFile(core, fixtureCore);
const nativeHome = join(scratch, 'native-home');
await mkdir(nativeHome, { recursive: true });
const mcpScript = join(scratch, 'fixture-mcp.cjs');
if (verifyResources) {
  await writeFile(mcpScript, `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:q.method==='tools/list'?{tools:[{name:process.argv[2]+'_fixture_echo',description:'Local fixture tool',inputSchema:{type:'object',properties:{}}}]}:q.method==='prompts/list'?{prompts:[]}:q.method==='resources/list'?{resources:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
  const nativeSpec = { command: process.execPath, args: [mcpScript, 'native'] };
  for (const folder of ['.kimi-code', '.commandcode', '.omp/agent']) {
    await mkdir(join(nativeHome, folder), { recursive: true });
    await writeFile(join(nativeHome, folder, 'mcp.json'), JSON.stringify({mcpServers:{native_fixture:nativeSpec}}));
  }
  await mkdir(join(nativeHome,'.config/opencode'),{recursive:true});
  await writeFile(join(nativeHome,'.config/opencode/opencode.json'),JSON.stringify({mcp:{native_fixture:{type:'local',command:[process.execPath,mcpScript,'native'],enabled:true}}}));
  if (harnesses.includes('trae')) await writeFile(join(scratch,'trae_config.yaml'), JSON.stringify({agents:{trae_agent:{max_steps:4,enable_lakeview:false,tools:['bash','task_done']}},mcp_servers:{native_fixture:nativeSpec},allow_mcp_servers:['native_fixture']}));
}
const fixtureEnv = { ...process.env, USERPROFILE:nativeHome, HOME:nativeHome, XDG_CONFIG_HOME:join(nativeHome,'.config'), AGENTHUB_DATA_DIR: scratch, AGENTHUB_SOCKET: socketPath, AGENTHUB_TOKEN_PATH: tokenPath };
if (harnesses.includes('deepseek')) Object.assign(fixtureEnv, { DSH_HOME: join(nativeHome, '.dsh'), DSH_AGENTS_HOME: join(nativeHome, '.agents'), APPDATA: join(nativeHome, 'AppData/Roaming'), LOCALAPPDATA: join(nativeHome, 'AppData/Local') });
for (const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','KIMI_CODE_HOME','PI_CODING_AGENT_DIR','OMP_PROFILE','PI_PROFILE','PI_CONFIG_DIR','PI_CONFIG_FILES','OPENCODE_CONFIG','OPENCODE_CONFIG_DIR','OPENCODE_CONFIG_CONTENT','TRAE_CONFIG_FILE']) delete fixtureEnv[key];
const child = spawn(fixtureCore, ['--serve'], { cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnv });
child.stderr.on('data', chunk => stderr.push(String(chunk)));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error('Core startup timed out')), 15000);
  let buffer = '';
  child.stdout.on('data', chunk => { buffer += chunk; for (const line of buffer.split('\n')) { try { if (JSON.parse(line).status === 'ok') { clearTimeout(timer); resolve(); return; } } catch {} } });
  child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(Error(`Core exited ${code}`)); });
});
const token = (await readFile(tokenPath, 'utf8')).trim();
async function ipc(method, input = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let phase = 0, buffer = '';
    socket.setTimeout(40000, () => socket.destroy(Error(`${method} timed out`)));
    socket.on('error', reject);
    socket.on('close', () => reject(Error(`${method}: fixture core connection closed`)));
    socket.on('connect', () => socket.write(JSON.stringify({ token }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk; let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); const message = JSON.parse(line);
        if (phase++ === 0) { if (!message.ok) { socket.destroy(); reject(Error('Fixture authentication failed')); return; } socket.write(JSON.stringify({ request: { method, input } }) + '\n'); }
        else { socket.destroy(); if (message.ok) resolve(message.data); else reject(Object.assign(Error(message.error?.details?.reason ?? message.error?.message ?? `${method} failed`), { code: message.error?.code })); }
      }
    });
  });
}
const results = [];
try {
  for (const id of pluginIds.filter(id => harnesses.includes(id))) {
    const folder = join(scratch, 'packages', id); await mkdir(folder, { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, 'rust/plugins', id, 'agenthub-plugin.json'), 'utf8'));
    manifest.main = `agenthub-plugin-${id}.exe`;
    await copyFile(join(binaries, manifest.main), join(folder, manifest.main));
    await writeFile(join(folder, 'agenthub-plugin.json'), JSON.stringify(manifest));
    await ipc('plugin.install', { source: { kind: 'local', path: folder } });
  }
  const now = new Date().toISOString();
  await ipc('policy.upsert', { id: 'fixture-policy', name: 'Fixture', defaultCommandAction: 'allow', commandRules: [], environmentAllowlist: ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA'], allowedPaths: [scratch], updatedAt: now });
  if (verifyResources) await ipc('capability.upsert',{id:'managed-fixture',kind:'mcp',name:'managed_fixture',description:'',enabled:true,providerIds:harnesses,tags:[],mcp:{transport:'stdio',command:process.execPath,args:[mcpScript,'managed']}});
  await ipc('project.upsert', { id: 'fixture-project', name: 'API fixture', rootPath: scratch, repositoryType: 'none', workspaceMode: 'direct', nonGitDiffMode: 'off', frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: 'fixture-policy' });
  for (const harness of harnesses) {
    let executable = { deepseek: process.env.NAUTILO_DEEPSEEK_TEST_CLI ?? 'dsh', 'kimi-code': join(process.env.USERPROFILE, '.kimi-code/bin/kimi.exe'), commandcode: 'command-code', 'claude-code': join(process.env.USERPROFILE, '.local/bin/claude.exe'), trae: process.env.NAUTILO_TRAE_EXECUTABLE ?? 'traecli' }[harness] ?? harness;
    try {
      if (harness === 'codex') executable = join(process.env.APPDATA, 'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
      if (executable.includes('/') || executable.includes('\\')) await access(executable);
      else execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [executable], { windowsHide: true, stdio: 'ignore' });
    } catch { console.log(`SKIP ${harness}: CLI not installed`); results.push({ harness, status: 'not-installed' }); continue; }
    const sessionId = `fixture-${harness}`;
    const connectionId = `fixture-api-${harness}`;
    let runId;
    let teamRunId;
    const before = calls.length;
    try {
      await ipc('connection.upsert', { connection: { id: connectionId, name: 'Local fixture', kind: 'api', enabled: true, protocol, baseUrl: baseUrl.replace('/v1', `/${harness}/v1`), models: [{ id: model, reasoningEfforts: harness === 'deepseek' ? ['off', 'high', 'max'] : ['low', 'max'], defaultReasoningEffort: harness === 'deepseek' ? 'max' : 'low' }] }, apiKey: fixtureKey });
      await ipc('agent.upsert', { id: `harness-${harness}`, providerId: harness, displayName: harness, executable, baseArgs: [], capabilities: [], enabled: true, status: 'available', createdAt: now, updatedAt: now, providerOptions: { configurationKind: 'harness', ...(harness === 'codex' ? { webSearchMode: 'native' } : {}) } });
      const teamId = `fixture-team-${harness}`;
      if (verifyTeam) await ipc('team.upsert', { id: teamId, name: 'Team launch fixture', roles: [], members: [], delegationPolicy: 'autonomous', createdAt: now, updatedAt: now });
      await ipc('session.upsert', { id: sessionId, projectId: 'fixture-project', memberId: `harness-${harness}`, agentInstanceId: `harness-${harness}`, ...(harness === 'deepseek' && verifyDshCompact ? { permissionMode: 'danger-full-access' } : {}), ...(verifyTeam ? { teamId } : {}), connectionId, connectionRevision: 1, model, reasoningEffort: effort, title: process.env.NAUTILO_NATIVE_TITLE === '1' ? 'Say hello only. Do not use any tools.' : 'Fixture', status: 'idle', unreadCount: 0, createdAt: now, updatedAt: now });
      if (verifyTeam) {
        const started = await ipc('orchestration.start', { projectId: 'fixture-project', teamId, agentInstanceId: `harness-${harness}`, sessionId, messageId: `${sessionId}-outgoing`, goal: 'Say hello only. Do not use any tools.' });
        teamRunId = started.projectRun.id;
        // A double acquisition of the database mutex here used to freeze the
        // entire daemon before the native CLI received its first request.
        for (let index = 0; index < 100 && !runId; index++) {
          assert.equal((await ipc('health.get')).status, 'ok', 'Team launch blocked the IPC gateway');
          runId = (await ipc('run.list', { sessionId }))[0]?.id;
          if (!runId) await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(runId, 'The team main-Agent run was never created');
      } else ({ runId } = await ipc('session.send', { sessionId, messageId: `${sessionId}-outgoing`, text: 'Say hello only. Do not use any tools.' + (harness === 'deepseek' && verifyDshCompact ? ' Synthetic context for compaction.'.repeat(500) : '') }));
      let run;
      const sub = await ipc('event.subscribe', { sessionId });
      const streaming = { thinking: new Set(), text: new Set() };
      for (let i = 0; i < Number(process.env.NAUTILO_NATIVE_POLL_LIMIT ?? 300); i++) {
        run = (await ipc('run.list', { sessionId })).find(item => item.id === runId);
        if (run && ['completed', 'failed', 'crashed', 'timed_out', 'cancelled'].includes(run.status)) break;
        if (verifyStream) {
          const live = await ipc('event.replay', { subscriptionId: sub.subscriptionId, afterSequence: 0 });
          for (const event of live.events.filter(event => event.runId === runId)) {
            if (event.type === 'agent.thinking_delta') streaming.thinking.add(event.payload.text);
            if (event.type === 'agent.message_delta') streaming.text.add(event.payload.text);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      let replay;
      // Terminal state is saved before its event; wait for the journal too.
      for (let i = 0; i < 20; i++) {
        replay = await ipc('event.replay', { subscriptionId: sub.subscriptionId, afterSequence: 0 });
        if (replay.events.some(event => event.runId === runId && ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const failure = replay.events.find(event => event.type === 'run.failed');
      assert.equal(run?.status, 'completed', failure?.payload?.message ?? `Unexpected run status ${run?.status}`);
      assert.equal((await ipc('session.get', { sessionId })).messages.filter(message => message.sender === 'user' && message.id === `${sessionId}-outgoing`).length, 1, 'The saved user message must retain its client identity');
      assert.ok(replay.events.some(event => event.type === 'agent.message' && event.payload.text.includes('Nautilo API fixture OK')), 'No assistant response reached the journal');
      if (verifyTeam) {
        let finishedProject;
        for (let index = 0; index < 100; index++) {
          finishedProject = (await ipc('projectRun.get', { projectRunId: teamRunId })).projectRun;
          if (['completed', 'failed', 'cancelled'].includes(finishedProject.status)) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(finishedProject.status, 'completed', 'The native team did not finish its initial project run');
        // Simulate an interrupted project in this disposable fixture database.
        const fixtureDb = new DatabaseSync(join(scratch, 'agenthub.sqlite'));
        const project = JSON.parse(fixtureDb.prepare('SELECT data FROM project_runs WHERE id=?').get(teamRunId).data);
        project.status = 'paused';
        fixtureDb.prepare('UPDATE project_runs SET data=? WHERE id=?').run(JSON.stringify(project), teamRunId);
        fixtureDb.close();
        const recovered = await ipc('orchestration.recover', { projectRunId: teamRunId, memberId: project.mainMemberId, mode: 'resume' });
        assert.equal(recovered.status, 'executing', 'Recovery changed a native team into a separate planning pipeline');
        let resumed;
        for (let index = 0; index < 150; index++) {
          assert.equal((await ipc('health.get')).status, 'ok', 'Team recovery blocked the IPC gateway');
          resumed = (await ipc('run.list', { sessionId })).find(item => item.id !== runId);
          if (resumed && ['completed', 'failed', 'crashed', 'timed_out', 'cancelled'].includes(resumed.status)) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(resumed?.status, 'completed', 'Recovered team did not complete its native main-Agent turn');
        console.log(`PASS ${harness}: team launch, IPC liveness and interrupted-team recovery`);
      }
      if (verifyStream) {
        assert.ok(streaming.thinking.size >= 2, `Reasoning was buffered: ${streaming.thinking.size} live updates`);
        assert.ok(streaming.text.size >= 2, `Text was buffered: ${streaming.text.size} live updates`);
        console.log(`PASS ${harness}: ${streaming.thinking.size} reasoning updates and ${streaming.text.size} text updates before completion`);
      }
      let compact;
      if (harness === 'deepseek' && verifyDshCompact) {
        const command = (await ipc('slashCommand.list', { sessionId })).find(item => item.providerCommand === 'compact');
        assert.ok(command, 'DSH did not expose its native compact command');
        assert.ok(calls.slice(before).some(call => call.effort === effort), 'DSH lost the selected chat effort');
        const execute = () => ipc('slashCommand.execute', { sessionId, commandId: command.id });
        rejectDshSummary = true;
        try {
          await assert.rejects(execute, { code: 'PROVIDER_COMMAND_FAILED', message: /Fixture rejected the summary request/ });
        } finally {
          rejectDshSummary = false;
        }
        const marker = calls.length;
        assert.equal((await execute()).completed, true);
        assert.ok(calls.slice(marker).some(call => call.dshSummary && call.effort === 'none'), 'DSH sent the wrong compaction effort');
        const followUp = await ipc('session.send', { sessionId, text: 'Continue from the checkpoint.' });
        let resumed;
        for (let i = 0; i < 300; i++) {
          resumed = (await ipc('run.list', { sessionId })).find(item => item.id === followUp.runId);
          if (resumed && ['completed', 'failed', 'cancelled', 'crashed', 'timed_out'].includes(resumed.status)) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(resumed?.status, 'completed');
        assert.ok(calls.slice(marker).some(call => !call.dshSummary && call.hasCheckpoint && call.effort === effort), 'Next turn lost the saved checkpoint or chat effort');
        console.log('PASS deepseek: upstream failure reason, native compaction retry and resume from the saved checkpoint');
      }
      if (harness === 'codex' && process.env.NAUTILO_NATIVE_COMPACT === '1') {
        const commands = await ipc('slashCommand.list', { sessionId });
        const command = commands.find(item => item.providerCommand === 'compact');
        assert.ok(command, 'The native compaction command is missing');
        const started = Date.now();
        const result = await ipc('slashCommand.execute', { sessionId, commandId: command.id });
        assert.equal(result.completed, true, 'The native compaction request did not finish');
        const runs = await ipc('run.list', { sessionId });
        const compactRun = runs.find(item => item.id !== runId);
        assert.equal(compactRun?.status, 'completed', 'Compaction left a run active or failed');
        compact = { status: compactRun.status, elapsedMs: Date.now() - started };
        console.log(`PASS codex: native /compact completed in ${compact.elapsedMs} ms`);
      }
      const upstream = calls.slice(before).filter(call => call.path.includes(`/${harness}/`));
      assert.ok(upstream.length, 'No request reached the selected endpoint');
      assert.ok(upstream.every(call => call.model === model), 'The CLI selected an unconfigured upstream model');
      assert.ok(upstream.every(call => call.authorization === `Bearer ${fixtureKey}`), 'The selected key did not reach the selected endpoint');
      if (verifyResources) {
        assert.ok(upstream.some(call=>call.nativeMcp),`${harness} did not expose its native MCP tool`);
        assert.ok(upstream.some(call=>call.managedMcp),`${harness} did not merge the Nautilo MCP tool`);
        console.log(`PASS ${harness}: native and Nautilo MCP tools are both present`);
      }
      if (verifyStream && (harness === 'opencode' || harness === 'omp' && protocol !== 'anthropic')) assert.ok(upstream.some(call => call.effort === effort), `${harness} dropped or changed the selected reasoning effort`);
      if (process.env.NAUTILO_NATIVE_CONTEXT === '1') {
        const beforeFollowUp=calls.length;
        const second=await ipc('session.send',{sessionId,text:'Continue the previous conversation. What did you just reply? Do not use tools.'});
        let next;
        for(let i=0;i<300;i++) {
          next=(await ipc('run.list',{sessionId})).find(item=>item.id===second.runId);
          if(next && ['completed','failed','cancelled','crashed','timed_out'].includes(next.status))break;
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        assert.equal(next?.status,'completed','The follow-up did not complete');
        assert.ok(calls.slice(beforeFollowUp).some(call=>call.hasPreviousReply),'The second native run lost the first assistant reply');
        console.log(`PASS ${harness}: a new native process retained the previous conversation`);
        if (harness === 'omp' && process.env.NAUTILO_NATIVE_LEGACY_CONTEXT === '1') {
          // Reproduce a conversation created by the old --no-session plugin.
          // Only the isolated fixture database is changed, never user data.
          const legacyDb=new DatabaseSync(join(scratch,'agenthub.sqlite'));
          try {
            const legacy=JSON.parse(legacyDb.prepare('SELECT data FROM sessions WHERE id=?').get(sessionId).data);
            delete legacy.providerContextVersion; legacy.providerSessionId='legacy-ephemeral-session';
            legacyDb.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(legacy),sessionId);
          } finally {legacyDb.close();}
          const marker=calls.length;
          const recovered=await ipc('session.send',{sessionId,text:'Continue our saved conversation after restoring the native session. Do not use tools.'});
          let restored;
          for(let i=0;i<300;i++) {
            restored=(await ipc('run.list',{sessionId})).find(item=>item.id===recovered.runId);
            if(restored && ['completed','failed','cancelled','crashed','timed_out'].includes(restored.status))break;
            await new Promise(resolve=>setTimeout(resolve,100));
          }
          assert.equal(restored?.status,'completed','A legacy ephemeral conversation could not recover');
          assert.ok(calls.slice(marker).some(call=>call.hasPreviousReply),'Legacy migration lost the saved conversation');
          console.log('PASS omp: a legacy ephemeral session recovered its saved chat');
        }
      }
      if (process.env.NAUTILO_NATIVE_TITLE === '1') {
        const generated = await ipc('session.generateTitle', { sessionId });
        assert.equal(generated.title, 'Nautilo API fixture OK', 'The generated title was not returned');
        const detail = await ipc('session.get', { sessionId });
        assert.equal(detail.session.title, generated.title, 'The generated title was not persisted');
        await ipc('session.upsert', { ...detail.session, title: 'My manual title' });
        assert.equal((await ipc('session.generateTitle', { sessionId })).title, 'My manual title', 'A manual title was overwritten');
        console.log(`PASS ${harness}: generated title persisted and manual rename preserved`);
      }
      console.log(`PASS ${harness}: saved API → native CLI → selected endpoint → persisted reply`);
      results.push({ harness, status: 'passed', requests: upstream.length, efforts: upstream.map(call => call.effort ?? null), ...(compact ? { compact } : {}) });
    } catch (error) {
      if (runId) {
        const run = (await ipc('run.list', { sessionId }).catch(() => [])).find(item => item.id === runId);
        if (run && !['completed', 'failed', 'crashed', 'timed_out', 'cancelled'].includes(run.status)) await ipc('run.cancel', { runId }).catch(() => {});
      }
      const message = error.message.split(fixtureKey).join('[fixture key]').slice(-1600);
      console.log(`FAIL ${harness}: ${message}`); results.push({ harness, status: 'failed', message });
    }
  }
} finally {
  await writeFile(join(scratch, 'result.json'), JSON.stringify({ protocol, effort, results, calls: calls.map(({ authorization, ...call }) => call), coreErrors: stderr.join('').slice(-2000) }, null, 2));
  for (const id of pluginIds.filter(id => harnesses.includes(id))) await ipc('plugin.setEnabled', { pluginId: id, enabled: false }).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
    } else child.kill();
    await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(scratch, 'result.json'), JSON.stringify({ protocol, effort, results, coreErrors: stderr.join('').slice(-2000) }, null, 2));
}
process.stdout.write(`Results: ${join(scratch, 'result.json')}\n`, () => process.exit(results.some(result => result.status === 'failed') ? 1 : 0));
