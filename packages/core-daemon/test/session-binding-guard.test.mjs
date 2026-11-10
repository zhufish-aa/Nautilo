import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSessionIdentityUpdate } from '../dist/runtime/session-binding-guard.js';

const session = { id: 'session', projectId: 'project', memberId: 'agent', agentInstanceId: 'agent', title: 'Conversation', status: 'idle', unreadCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const fixture = ({ runs = [], messages = [], team } = {}) => ({
  runs: { list: () => runs },
  sessions: { messages: () => messages },
  teams: { get: () => team }
});
const reject = (current, update, db) => assert.throws(() => assertSessionIdentityUpdate(current, { ...current, ...update }, db), (error) => error.descriptor?.code === 'IPC_INVALID_REQUEST');

test('unstarted sessions may change agent and project', () => {
  assertSessionIdentityUpdate(session, { ...session, agentInstanceId: 'other', projectId: 'other' }, fixture());
});

for (const evidence of ['messages', 'provider', 'completed run', 'active run']) {
  test(`started session identity is immutable with ${evidence}, even if renderer says idle`, () => {
    const current = { ...session, ...(evidence === 'provider' ? { providerSessionId: 'native-thread' } : {}) };
    const db = fixture({ messages: evidence === 'messages' ? [{ id: 'message' }] : [], runs: evidence.endsWith('run') ? [{ sessionId: session.id, status: evidence === 'active run' ? 'running' : 'completed' }] : [] });
    reject(current, { agentInstanceId: 'other' }, db);
    reject(current, { projectId: 'other' }, db);
    assertSessionIdentityUpdate(current, { ...current, memberId: 'team-routing-member' }, db);
  });
}

test('legacy direct-agent conversations cannot switch through memberId, but may acquire same explicit identity', () => {
  const current = { ...session, agentInstanceId: undefined, providerSessionId: 'native-thread' };
  reject(current, { memberId: 'other' }, fixture());
  assertSessionIdentityUpdate(current, { ...current, agentInstanceId: 'agent', memberId: 'team-routing-member' }, fixture());
});

test('legacy team member identity is resolved without requiring enabled agent state', () => {
  const current = { ...session, agentInstanceId: undefined, memberId: 'member-a', teamId: 'team', providerSessionId: 'native-thread' };
  const db = fixture({ team: { members: [{ id: 'member-a', agentInstanceId: 'agent' }, { id: 'member-b', agentInstanceId: 'agent' }, { id: 'member-c', agentInstanceId: 'other' }] } });
  assertSessionIdentityUpdate(current, { ...current, memberId: 'member-b' }, db);
  assertSessionIdentityUpdate(current, { ...current, agentInstanceId: 'agent' }, db);
  reject(current, { memberId: 'member-c' }, db);
  reject(current, { agentInstanceId: 'other' }, db);
});

for (const status of ['starting', 'running', 'waiting', 'queued']) {
  test(`${status} run rejects request configuration changes but permits unrelated metadata`, () => {
    const current = { ...session, model: 'model-a', reasoningEffort: 'high', serviceTier: 'auto' };
    const db = fixture({ runs: [{ sessionId: session.id, status }] });
    for (const field of ['model', 'reasoningEffort', 'serviceTier']) reject(current, { [field]: 'changed' }, db);
    reject(current, { model: undefined }, db);
    assertSessionIdentityUpdate(current, { ...current, title: 'Renamed', memberId: 'team-member' }, db);
    const { model, ...omitted } = current;
    assertSessionIdentityUpdate(current, omitted, db);
  });
}

test('terminal runs permit model and effort changes and do not lock account/provider between requests', () => {
  for (const status of ['completed', 'failed', 'timed_out', 'crashed', 'cancelled']) {
    const db = fixture({ runs: [{ sessionId: session.id, status }, { sessionId: 'other-session', status: 'running' }] });
    assertSessionIdentityUpdate(session, { ...session, model: 'next-model', reasoningEffort: 'low', serviceTier: 'fast', connectionId: 'another-account', connectionRevision: 2 }, db);
  }
});

test('session upsert enforces identity and active-run settings before persisting', async () => {
  const { Database } = await import('../dist/database/index.js');
  const { SessionService } = await import('../dist/application/session-service.js');
  const db = new Database(':memory:');
  const service = new SessionService(db, {}, {});
  const current = { ...session, providerSessionId: 'native-thread', model: 'model-a', reasoningEffort: 'high' };
  try {
    db.sessions.save(current);
    for (const change of [{ agentInstanceId: 'other' }, { projectId: 'other' }]) {
      assert.throws(() => service.upsert({ ...current, ...change }), (error) => error.descriptor?.code === 'IPC_INVALID_REQUEST');
      assert.deepEqual(db.sessions.get(current.id), current);
    }
    const idle = service.upsert({ ...current, model: 'model-b', reasoningEffort: 'low', memberId: 'team-route' });
    assert.equal(idle.model, 'model-b');
    assert.equal(idle.providerSessionId, 'native-thread');
    db.runs.save({ id: 'active', sessionId: current.id, status: 'running' });
    assert.throws(() => service.upsert({ ...idle, model: 'model-c' }), (error) => error.descriptor?.code === 'IPC_INVALID_REQUEST');
    assert.equal(db.sessions.get(current.id).model, 'model-b');
  } finally { db.close(); }
});
