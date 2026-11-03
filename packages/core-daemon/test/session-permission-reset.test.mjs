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
