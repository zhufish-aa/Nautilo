import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, AdapterRegistry, EventService, RunService, CredentialService } from '../dist/index.js';
import { ConnectionService } from '../dist/application/connection-service.js';
import { SessionService } from '../dist/application/session-service.js';
import { SessionRouter } from '../dist/runtime/orchestration/session-router.js';
import { TeamService } from '../dist/application/team-service.js';
import { IpcGateway } from '../dist/ipc-gateway.js';
import { registerIpcHandlers } from '../dist/application/ipc-handlers.js';
import { buildSessionTurnContext } from '../dist/application/session-context.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-connections-'));
  const db = new Database(':memory:');
  const now = new Date().toISOString();
  const requests = [];
  let gate;
  let exitCode = 0;
  const adapter = { providerId: 'codex', descriptor: { credentialEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'] },
    supportsStructuredOutput: true, supportsResume: true,
    capabilities: { structuredOutput: true, textOutput: true, interactiveStdin: false, nativeResume: true, pty: false },
    start: (request) => run(request, false), resume: (request) => run(request, true) };
  const run = (request, resumed) => {
    requests.push({ request, resumed });
    async function* events() {
      if (gate) await gate;
      yield { kind: 'session', providerSessionId: `native-${requests.length}` };
      yield { kind: 'message', text: `answer-${requests.length}` };
      yield { kind: 'usage', inputTokens: 3, outputTokens: 2, usageScope: 'turn' };
      yield { kind: 'exit', exitCode };
    }
    return { process: {}, events: events(), cancel: async () => {}, write: () => {} };
  };
  const adapters = new AdapterRegistry([adapter]);
  const credentials = new CredentialService(db, root, adapters);
  const events = new EventService(db);
  const runs = new RunService(db, adapters, events, credentials, { build: (_, additions) => ({ HOME: root, OPENAI_API_KEY: 'ambient-secret', anthropic_auth_token: 'wrong-auth', Claude_Code_Use_Bedrock: '1', codex_home: '/wrong-account', ...additions }) });
  const connections = new ConnectionService(db, credentials, adapters);
  const sessions = new SessionService(db, runs, events);
  const agent = { id: 'a', providerId: 'codex', displayName: 'CLI', executable: 'fake', baseArgs: [], capabilities: [], enabled: true, status: 'available', createdAt: now, updatedAt: now, providerOptions: { baseUrl: 'https://legacy.example/v1' } };
  const project = { id: 'p', name: 'P', rootPath: root, repositoryType: 'none', nonGitDiffMode: 'off', frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: 'default' };
  db.projects.save(project, now); db.agents.save(agent, now);
  const input = (id = 'supplier', patch = {}) => ({ id, name: id, kind: 'api', enabled: true, protocol: 'responses', baseUrl: 'https://one.example/v1', models: [{ id: 'model-a', reasoningEfforts: ['low', 'high'], pricing: { input: 1, output: 2 } }], ...patch });
  const session = (id = 's', extra = {}) => sessions.upsert({ id, projectId: 'p', memberId: 'a', agentInstanceId: 'a', title: id, status: 'idle', unreadCount: 0, createdAt: now, updatedAt: now, ...extra });
  t.after(async () => { await runs.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, credentials, connections, sessions, runs, events, requests, agent, adapter, adapters, input, session, setGate: (value) => { gate = value; }, setExit: (value) => { exitCode = value; } };
}

test('connections are independent, revisioned and secret-free; stale writes are rejected', async (t) => {
  const f = await fixture(t);
  const first = f.connections.upsert({ connection: f.input(), apiKey: 'key-one' });
  assert.equal(first.revision, 1); assert.equal(first.hasCredential, true);
  assert.equal(f.db.agents.list().length, 1);
  assert.equal(JSON.stringify(f.connections.list()).includes('key-one'), false);
  const encrypted = f.db.credentials.get('connection:supplier:1');
  const next = f.connections.upsert({ connection: f.input('supplier', { name: 'Renamed', baseUrl: 'https://two.example/v1' }), expectedRevision: 1 });
  assert.equal(next.revision, 2);
  assert.deepEqual(f.db.credentials.get('connection:supplier:2'), encrypted);
  assert.equal(f.connections.get('supplier', 1).baseUrl, 'https://one.example/v1');
  assert.throws(() => f.connections.upsert({ connection: f.input(), expectedRevision: 1, apiKey: 'wrong' }));
  assert.equal(f.connections.get('supplier').revision, 2);
  assert.equal(f.db.credentials.has('connection:supplier:3'), false);
  assert.ok(f.credentials.secretValues().includes('key-one'));
});

test('an unknown plugin receives its declared native endpoint and key without host registration rules', async t => {
  const f = await fixture(t);
  f.adapters.register({ ...f.adapter, providerId: 'third-party-fixture', descriptor: { providerId: 'third-party-fixture', credentialEnv: ['CUSTOM_FIXTURE_KEY'], baseUrlEnv: 'CUSTOM_FIXTURE_URL' } });
  const plugin = { ...f.agent, id: 'plugin-harness', providerId: 'third-party-fixture', providerOptions: { configurationKind: 'harness' } };
  f.db.agents.save(plugin, plugin.updatedAt);
  f.connections.upsert({ connection: f.input('plugin-api', { protocol: 'chat', models: [{ id: 'only-model', reasoningEfforts: ['max'] }] }), apiKey: 'plugin-owned-key' });
  const session = f.session('plugin-session', { memberId: plugin.id, agentInstanceId: plugin.id, connectionId: 'plugin-api', model: 'only-model', reasoningEffort: 'max' });
  await (await f.runs.launch(session, plugin, 'Hello from a new plugin')).completion;
  const request = f.requests[0].request;
  assert.equal(request.instance.providerId, 'third-party-fixture');
  assert.equal(request.instance.providerOptions.apiType, 'openai-completions');
  assert.equal(request.env.CUSTOM_FIXTURE_URL, 'https://one.example/v1');
  assert.equal(request.env.CUSTOM_FIXTURE_KEY, 'plugin-owned-key');
  assert.equal(request.env.NAUTILO_CONNECTION_API_KEY, 'plugin-owned-key');
  assert.equal(request.model, 'only-model'); assert.equal(request.reasoningEffort, 'max');
  assert.deepEqual(f.db.agents.get(plugin.id).providerOptions, { configurationKind: 'harness' });
});

test('real RunService uses pinned connection endpoint/key/model and per-run pricing without mutating CLI', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input(), apiKey: 'key-one' });
  const s = f.session('s', { connectionId: 'supplier' });
  assert.equal(s.connectionRevision, 1); assert.equal(s.model, 'model-a');
  f.connections.upsert({ connection: f.input('supplier', { baseUrl: 'https://two.example/v1' }), expectedRevision: 1, apiKey: 'key-two' });
  const handle = await f.runs.launch(s, f.agent, 'hello'); await handle.completion;
  const request = f.requests[0].request;
  assert.equal(request.instance.providerOptions.baseUrl, 'https://one.example/v1');
  assert.equal(request.env.OPENAI_API_KEY, 'key-one');
  assert.equal(request.model, 'model-a');
  for (const key of ['anthropic_auth_token', 'Claude_Code_Use_Bedrock', 'codex_home']) assert.equal(request.env[key], undefined);
  assert.equal(f.db.agents.get('a').providerOptions.baseUrl, 'https://legacy.example/v1');
  const run = f.db.runs.get(handle.runId);
  assert.equal(run.connectionRevision, 1); assert.deepEqual(run.pricingSnapshot, { input: 1, output: 2 });
  const usage = f.db.events.replay({ sessionId: 's' }).find((e) => e.type === 'usage.updated');
  assert.equal(usage.payload.connectionRevision, 1); assert.deepEqual(usage.payload.pricingSnapshot, run.pricingSnapshot);
  assert.throws(() => f.connections.remove('supplier'));
});

test('idle connection switching requires confirmation, clears native identity and retains full text', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input('one'), apiKey: 'key-one' });
  f.connections.upsert({ connection: f.input('two'), apiKey: 'key-two' });
  let s = f.session('s', { connectionId: 'one' });
  await (await f.runs.launch(s, f.agent, 'first')).completion;
  s = f.db.sessions.get('s');
  for (let i = 0; i < 30; i++) f.db.sessions.saveMessage({ id: `history-${i}`, sessionId: 's', sender: 'user', text: `stored-text-${i}`, createdAt: new Date(1000 + i).toISOString() });
  assert.throws(() => f.sessions.upsert({ ...s, connectionId: 'two', connectionRevision: undefined }));
  for (const value of ['false', 'true', 1, {}]) assert.throws(() => f.sessions.upsert({ ...s, connectionId: 'two', connectionRevision: undefined, confirmConnectionChange: value }));
  const switched = f.sessions.upsert({ ...s, connectionId: 'two', connectionRevision: undefined, confirmConnectionChange: true });
  assert.equal(switched.providerSessionId, undefined); assert.equal(switched.connectionContextRebuildRequired, true);
  const result = await f.sessions.send({ sessionId: 's', text: 'continue' });
  // Await the persisted completion without reaching into SessionService's adapter.
  for (let i = 0; i < 100 && !['completed', 'failed'].includes(f.db.runs.get(result.runId)?.status); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.requests.at(-1).resumed, false);
  assert.equal(f.requests.at(-1).request.env.OPENAI_API_KEY, 'key-two');
  assert.match(f.requests.at(-1).request.prompt, /stored-text-0/);
  assert.match(f.requests.at(-1).request.prompt, /stored-text-29/);
  assert.equal(f.db.sessions.get('s').connectionContextRebuildRequired, false);
  const cleared = f.sessions.upsert({ ...f.db.sessions.get('s'), connectionId: null, connectionRevision: null, confirmConnectionChange: true });
  assert.equal(cleared.connectionId, undefined);
});

test('busy switching, unsupported protocol, missing credentials and disabled connections fail explicitly', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input('one'), apiKey: 'one' }); f.connections.upsert({ connection: f.input('two') });
  const s = f.session('s', { connectionId: 'one' });
  let release; const gate = new Promise((r) => { release = r; }); f.setGate(gate);
  const running = await f.runs.launch(s, f.agent, 'busy');
  assert.throws(() => f.sessions.upsert({ ...f.db.sessions.get('s'), connectionId: 'two', connectionRevision: undefined, confirmConnectionChange: true }));
  release(); await running.completion; f.setGate(undefined);
  const switched = f.sessions.upsert({ ...f.db.sessions.get('s'), connectionId: 'two', connectionRevision: undefined, confirmConnectionChange: true });
  await assert.rejects(f.runs.launch(switched, f.agent, 'no key'));
  assert.equal(f.requests.length, 1);
  f.connections.upsert({ connection: f.input('one', { enabled: false }), expectedRevision: 1 });
  f.db.agents.save({ ...f.agent, id: 'unsupported', providerId: 'pi' }, f.agent.updatedAt);
  assert.equal(f.session('plugin-api', { agentInstanceId: 'unsupported', memberId: 'unsupported', connectionId: 'two' }).connectionId, 'two', 'plugins use the same generic API binding contract');
  assert.throws(() => f.session('disabled', { connectionId: 'one', connectionRevision: 1 }));
});

test('login connection chooses only its directory and never inherits API credentials', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input('account', { kind: 'login', harness: 'codex', loginProfileDirectory: join(f.root, 'account-a'), protocol: undefined, baseUrl: undefined }) });
  const s = f.session('s', { connectionId: 'account' });
  await (await f.runs.launch(s, f.agent, 'account')).completion;
  assert.equal(f.requests[0].request.env.CODEX_HOME, join(f.root, 'account-a'));
  assert.equal(f.requests[0].request.env.OPENAI_API_KEY, undefined);
  assert.equal(f.requests[0].request.instance.providerOptions.baseUrl, undefined);
  assert.throws(() => f.connections.upsert({ connection: f.input('bad', { kind: 'login', harness: 'pi', loginProfileDirectory: join(f.root, 'bad') }) }));
});

test('full-history rebuild rejects oversize instead of dropping earlier text', () => {
  assert.throws(() => buildSessionTurnContext({ currentText: 'go', messages: [{ sender: 'user', text: 'x'.repeat(1024 * 1024 + 1) }], artifacts: [], recoverProviderContext: true, fullHistory: true }), /1 MiB/);
});


test('public credential IPC cannot overwrite or delete immutable connection credentials', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input(), apiKey: 'original' });
  const gateway = new IpcGateway();
  registerIpcHandlers(gateway, { database: f.db, credentials: f.credentials });
  for (const method of ['credential.set', 'credential.delete']) {
    const result = await gateway.dispatch({ method, input: { agentInstanceId: 'connection:supplier:1', apiKey: 'overwritten' } });
    assert.equal(result.ok, false);
    assert.equal(f.credentials.environment('connection:supplier:1', 'codex').OPENAI_API_KEY, 'original');
  }
});


test('Anthropic connections canonicalize versioned endpoints to a shared root without losing relay prefix', async (t) => {
  const f = await fixture(t);
  for (const [suffix, expected] of [['/v1', '/relay'], ['/v1/messages', '/relay'], ['', '/relay']]) {
    const connection = f.connections.upsert({ connection: f.input('url' + suffix.length, { protocol: 'anthropic', baseUrl: 'https://api.example/relay' + suffix }), apiKey: 'key' });
    assert.equal(new URL(connection.baseUrl).pathname, expected);
  }
});


test('connection mutation flags reject truthy nonbooleans and invalid revisions', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input(), apiKey: 'original' });
  for (const clearApiKey of ['false', 1, {}]) assert.throws(() => f.connections.upsert({ connection: f.input(), expectedRevision: 1, clearApiKey }));
  for (const expectedRevision of ['1', 1.5, 0]) assert.throws(() => f.connections.upsert({ connection: f.input(), expectedRevision }));
  assert.equal(f.connections.get('supplier').revision, 1);
});

test('team child inherits an immutable connection and cannot silently use an incompatible harness', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input(), apiKey: 'team-key' });
  const parent = f.session('parent', { connectionId: 'supplier' });
  const router = new SessionRouter(f.db);
  const projectRun = { id: 'team-run', projectId: 'p', teamId: 'team', mainMemberId: 'main', mainAgentInstanceId: 'a' };
  const team = { id: 'team' };
  const child = router.delegated(projectRun, team, { id: 'worker', agentInstanceId: 'a' }, parent, 'task', 'Child');
  assert.equal(child.connectionId, 'supplier'); assert.equal(child.connectionRevision, 1);
  await (await f.runs.launch(child, f.agent, 'child')).completion;
  assert.equal(f.requests[0].request.env.OPENAI_API_KEY, 'team-key');
  f.db.agents.save({ ...f.agent, id: 'pi', providerId: 'pi', baseArgs: ['--custom-routing'] }, f.agent.updatedAt);
  assert.throws(() => router.delegated(projectRun, team, { id: 'pi-worker', agentInstanceId: 'pi' }, parent, 'other', 'Unsupported'));
  f.db.sessions.saveMessage({ id: 'started', sessionId: parent.id, sender: 'user', text: 'hi', createdAt: f.agent.createdAt });
  assert.throws(() => router.main({ ...projectRun, mainAgentInstanceId: 'pi' }, team, parent.id));
  assert.equal(f.db.sessions.get(parent.id).agentInstanceId, 'a');
});


test('failed switched-source turn keeps full-context rebuild pending and retry never resumes that native thread', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input('one'), apiKey: 'one' });
  f.connections.upsert({ connection: f.input('two'), apiKey: 'two' });
  const original = f.session('s', { connectionId: 'one' });
  await (await f.runs.launch(original, f.agent, 'first')).completion;
  const switched = f.sessions.upsert({ ...f.db.sessions.get('s'), connectionId: 'two', connectionRevision: undefined, confirmConnectionChange: true });
  f.setExit(1);
  const failed = await f.runs.launch(switched, f.agent, 'failed rebuild'); await failed.completion;
  assert.equal(f.db.runs.get(failed.runId).status, 'failed');
  assert.equal(f.db.sessions.get('s').connectionContextRebuildRequired, true);
  f.setExit(0);
  await (await f.runs.launch(f.db.sessions.get('s'), f.agent, 'manual retry')).completion;
  assert.deepEqual(f.requests.map((r) => r.resumed), [false, false, false]);
  assert.equal(f.db.sessions.get('s').connectionContextRebuildRequired, false);
});


test('login discovers models with a clean harness and account directory without agent selection', async (t) => {
  const f = await fixture(t);
  f.adapter.descriptor.defaultExecutable = 'default-codex';
  const probes = [];
  f.adapter.listModels = async (instance, context) => {
    probes.push({ instance, context });
    return { providerId: 'codex', models: [{ id: 'account-model', displayName: 'Account model' }], source: 'provider_cli', fetchedAt: new Date().toISOString() };
  };
  f.db.agents.save({ ...f.agent, baseArgs: ['--config', 'old'], profile: 'old-profile', models: [{ id: 'legacy-model' }] }, f.agent.updatedAt);
  for (const id of ['account-one', 'account-two']) {
    f.connections.upsert({ connection: f.input(id, { kind: 'login', harness: 'codex', loginProfileDirectory: join(f.root, id), protocol: undefined, baseUrl: undefined, models: undefined }) });
    const catalog = await f.connections.discover({ connectionId: id });
    assert.equal(catalog.models[0].id, 'account-model');
    const { instance, context } = probes.at(-1);
    assert.deepEqual(instance.baseArgs, []);
    assert.equal(instance.profile, undefined);
    assert.equal(instance.providerOptions.baseUrl, undefined);
    assert.equal(context.env.CODEX_HOME, join(f.root, id));
    assert.equal(context.env.OPENAI_API_KEY, undefined);
    assert.equal((instance.models ?? []).some(model => model.id === 'legacy-model'), false);
  }
  f.db.agents.remove('a');
  await f.connections.discover({ connectionId: 'account-one' });
  assert.equal(probes.at(-1).instance.executable, 'default-codex');
});

test('team members use their own pinned connection during delegation and recovery', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input('parent-account'), apiKey: 'parent-key' });
  f.connections.upsert({ connection: f.input('worker-account'), apiKey: 'worker-key' });
  const teams = new TeamService(f.db);
  const team = teams.upsert({ id: 'team', name: 'Team', members: [{ id: 'worker', agentInstanceId: 'a', connectionId: 'worker-account', model: 'worker-model', enabled: true }], roles: [], createdAt: f.agent.createdAt, updatedAt: f.agent.updatedAt });
  const member = team.members[0];
  assert.equal(member.connectionRevision, 1);
  f.connections.upsert({ connection: f.input('worker-account'), expectedRevision: 1, apiKey: 'new-worker-key' });
  const parent = f.session('parent', { connectionId: 'parent-account' });
  const run = { id: 'team-run', projectId: 'p', teamId: 'team', mainMemberId: 'worker', mainAgentInstanceId: 'a', goal: 'task' };
  const router = new SessionRouter(f.db);
  const child = router.delegated(run, team, member, parent, 'task', 'Child');
  assert.equal(child.agentInstanceId, 'a');
  assert.equal(child.connectionId, 'worker-account');
  assert.equal(child.connectionRevision, 1);
  assert.equal(child.model, 'worker-model');
  await (await f.runs.launch(child, f.agent, 'child')).completion;
  assert.equal(f.requests[0].request.env.OPENAI_API_KEY, 'worker-key');
  assert.throws(() => router.delegated(run, team, { ...member, connectionId: 'parent-account' }, parent, 'task', 'Changed'));
  assert.throws(() => router.delegated(run, team, { ...member, connectionRevision: 2 }, parent, 'task-2', 'Changed', child.id));
  const recovery = router.replacementMain(run, team, 'worker', parent);
  assert.equal(recovery.connectionId, 'worker-account');
  assert.equal(recovery.connectionRevision, 1);
  const main = router.main({ ...run, id: 'new-team-run' }, team);
  assert.equal(main.connectionId, 'worker-account');
  assert.equal(main.model, 'worker-model');
});

test('runtime-only harness requires an explicit source before launch', async (t) => {
  const f = await fixture(t);
  const harness = { ...f.agent, providerOptions: { configurationKind: 'harness' } };
  f.db.agents.save(harness, f.agent.updatedAt);
  await assert.rejects(f.runs.launch(f.session(), harness, 'without a source'));
  assert.equal(f.requests.length, 0);
});


test('initial source binding on a blank persisted draft needs no history-transfer confirmation', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input(), apiKey: 'key' });
  const blank = f.session('blank');
  const bound = f.sessions.upsert({ ...blank, connectionId: 'supplier', connectionRevision: 1 });
  assert.equal(bound.connectionId, 'supplier');
  assert.equal(Boolean(bound.connectionContextRebuildRequired), false);
  const resent = f.sessions.upsert(bound);
  await (await f.runs.launch(resent, f.agent, 'hi')).completion;
  assert.equal(f.requests[0].request.env.OPENAI_API_KEY, 'key');
  const history = f.session('history');
  f.db.sessions.saveMessage({ id: 'old-text', sessionId: history.id, sender: 'user', text: 'previous message', createdAt: f.agent.createdAt });
  assert.throws(() => f.sessions.upsert({ ...history, connectionId: 'supplier', connectionRevision: 1 }));
});


test('runtime forwards inherited Harness permissions and per-session overrides to adapters', async (t) => {
  const f = await fixture(t);
  f.connections.upsert({ connection: f.input(), apiKey: 'key' });
  for (const mode of ['full-access', 'bypassPermissions', 'yolo', 'auto', 'build', 'plan']) {
    const harness = { ...f.agent, providerOptions: { permissionMode: mode } };
    const session = f.session('permission-' + mode, { connectionId: 'supplier' });
    await (await f.runs.launch(session, harness, 'check permissions')).completion;
    assert.equal(f.requests.at(-1).request.permissionMode, mode);
    const overridden = f.sessions.upsert({ ...session, permissionMode: 'ask' });
    await (await f.runs.launch(overridden, harness, 'override permissions')).completion;
    assert.equal(f.requests.at(-1).request.permissionMode, 'ask');
  }
});
