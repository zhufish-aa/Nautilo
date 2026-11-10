import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreDaemon } from '../dist/index.js';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "nautilo-permission-test-"));
  const daemon = new CoreDaemon({ dataDir, databasePath: ':memory:', enableGitWorkflows: false });
  const now = new Date().toISOString();
  const project = { id: 'permission-project', name: 'Project', rootPath: process.cwd(), repositoryType: 'none', frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: 'default' };
  const agent = { id: 'permission-agent', providerId: 'codex', displayName: 'Agent', executable: 'codex', baseArgs: [], capabilities: [], enabled: true, status: 'available', permissionMode: 'ask', createdAt: now, updatedAt: now };
  const session = { id: 'permission-session', projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: 'Session', status: 'idle', unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.agents.save(agent, now);
  await daemon.plugins.ready;
  return { daemon, session, cleanup: async () => { await daemon.stop(); await rm(dataDir, { recursive: true, force: true }); } };
}
const wire = (input) => JSON.parse(JSON.stringify(input));

test('JSON null clears dangerous session override without resetting native thread', async () => {
  const { daemon, session, cleanup } = await fixture();
  try {
    daemon.database.sessions.save({ ...session, permissionMode: 'full-access', providerSessionId: 'native-thread', providerContextSyncedAt: session.createdAt });
    const response = await daemon.gateway.dispatch({ method: 'session.upsert', input: wire({ ...session, permissionMode: null }) });
    assert.equal(response.ok, true);
    assert.equal(response.data.permissionMode, undefined);
    assert.equal(response.data.providerSessionId, 'native-thread');
    const persisted = daemon.database.sessions.get(session.id);
    assert.equal(persisted.permissionMode, undefined);
    assert.equal(persisted.providerContextSyncedAt, session.createdAt);
    assert.equal(persisted.permissionMode ?? daemon.database.agents.get(session.agentInstanceId).permissionMode, 'ask');
    // A later renderer full upsert cannot revive the previous elevated value.
    daemon.sessions.upsert(wire({ ...session, permissionMode: null }));
    assert.equal(daemon.database.sessions.get(session.id).permissionMode, undefined);
  } finally { await cleanup(); }
});

test('omitted permission is backward-compatible while explicit plan reset survives serialization', async () => {
  const { daemon, session, cleanup } = await fixture();
  try {
    daemon.database.sessions.save({ ...session, permissionMode: 'full-access' });
    const omitted = wire({ ...session, permissionMode: undefined });
    assert.equal(Object.hasOwn(omitted, 'permissionMode'), false);
    assert.equal(daemon.sessions.upsert(omitted).permissionMode, 'full-access');
    assert.equal(daemon.sessions.upsert(wire({ ...session, permissionMode: ' plan ' })).permissionMode, 'plan');
    assert.equal(daemon.sessions.upsert(wire({ ...session, permissionMode: null })).permissionMode, undefined);
    assert.equal(daemon.database.sessions.get(session.id).permissionMode, undefined);
  } finally { await cleanup(); }
});

test('new sessions accept explicit inheritance and store no nullable domain permission', async () => {
  const { daemon, session, cleanup } = await fixture();
  try {
    const created = daemon.sessions.upsert(wire({ ...session, permissionMode: null }));
    assert.equal(created.permissionMode, undefined);
    assert.equal(Object.hasOwn(daemon.database.sessions.get(session.id), 'permissionMode'), false);
  } finally { await cleanup(); }
});


test('each resumed Codex turn sends the selected permission policy, including reset', async () => {
  const { buildCodexTurnStartParams } = await import('../dist/adapters/codex/app-server-run.js');
  const request = { instance: { providerId: 'codex', baseArgs: [], permissionMode: 'ask', providerOptions: { permissionMode: 'ask' } }, cwd: process.cwd(), prompt: 'test' };
  for (const [permissionMode, approvalPolicy, type] of [['ask', 'on-request', 'workspaceWrite'], ['full-access', 'never', 'dangerFullAccess'], ['auto', 'on-failure', 'workspaceWrite']]) {
    const params = buildCodexTurnStartParams({ ...request, permissionMode }, 'existing-thread');
    assert.equal(params.threadId, 'existing-thread');
    assert.equal(params.approvalPolicy, approvalPolicy);
    assert.deepEqual(params.sandboxPolicy, { type });
  }
  assert.equal(buildCodexTurnStartParams(request, 'existing-thread').approvalPolicy, 'on-request');
});


test('Kimi applies permission mode on each connection and propagates rejected changes', async () => {
  const { applyConfig } = await import('../dist/adapters/kimi/acp-run.js');
  const calls = [];
  const rpc = { request: async (method, input) => { calls.push({ method, input }); return {}; } };
  const response = { configOptions: [{ id: 'model', name: 'model' }, { id: 'mode', name: 'mode' }] };
  const instance = { providerId: 'kimi-code', providerOptions: { permissionMode: 'yolo' } };
  await applyConfig(rpc, 'resumed', response, { instance });
  assert.deepEqual(calls[0], { method: 'session/set_config_option', input: { sessionId: 'resumed', configId: 'mode', value: 'yolo' } });
  await applyConfig(rpc, 'resumed', response, { instance, permissionMode: 'default' });
  assert.equal(calls[1].input.value, 'default');
  const failed = { request: async () => { throw new Error('mode rejected'); } };
  await assert.rejects(applyConfig(failed, 'resumed', response, { instance }), /mode rejected/);
  await assert.rejects(applyConfig(rpc, 'resumed', {}, { instance }), /does not advertise/);
  await applyConfig(rpc, 'old-cli', { modes: { availableModes: [{ id: 'yolo' }] } }, { instance });
  assert.equal(calls.at(-1).method, 'session/set_mode');
});

test('Kimi does not silently ignore rejected model or reasoning selection', async () => {
  const { applyConfig } = await import('../dist/adapters/kimi/acp-run.js');
  const response = { configOptions: [{ id: 'model', name: 'model' }, { id: 'thinking', name: 'thinking' }] };
  for (const selection of [{ model: 'chosen-model' }, { reasoningEffort: 'high' }]) {
    let attempted;
    const rpc = { request: async (_method, params) => { attempted = params; throw new Error('selection rejected'); } };
    await assert.rejects(applyConfig(rpc, 'session', response, { instance: { providerId: 'kimi-code' }, ...selection }), /selection rejected/);
    assert.equal(attempted.value, selection.model ?? selection.reasoningEffort);
  }
});
