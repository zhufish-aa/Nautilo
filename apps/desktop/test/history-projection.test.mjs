import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, delta } from './helpers/orchestration-runtime-harness.mjs';
import { projectFixture, settle } from './helpers/project-poll-harness.mjs';
const clone = (value) => JSON.parse(JSON.stringify(value));
const row = (id, text = id, sessionId = 's') => ({ id, sessionId, sender: 'user', text, createdAt: '2026-11-03T00:00:00Z' });
const snapshot = (h, text = 'old', epoch = 'fixture') => ({ session: clone(h.session), reset: true, cursor: { epoch, scope: 'messages:session:s', revision: 1 }, items: [{ value: row('m', text), order: { createdAt: h.session.createdAt, ordinal: 1 } }] });

test('standalone warm sync retains array identity, appends a row, and never uses full legacy reads', async () => {
  const h = createHarness();
  h.replies['session.get'].messages = [row('a'), row('b')];
  await settle(h, () => h.runtime.hydrateStandaloneSession(h.session));
  const previous = h.runtime.standaloneMessageCache.get('s');
  await settle(h, () => h.runtime.refreshStandaloneSessionState(h.session));
  assert.equal(h.runtime.standaloneMessageCache.get('s'), previous);
  h.replies['session.get'].messages.push(row('c'));
  await settle(h, () => h.runtime.refreshStandaloneSessionState(h.session));
  assert.deepEqual(Array.from(h.runtime.standaloneMessageCache.get('s'), (m) => m.id), ['a', 'b', 'c']);
  assert.equal(h.calls.filter((c) => ['session.get', 'artifact.list'].includes(c.method)).length, 0);
});

test('same-timestamp edits and deletion without runtime events update a visible project history', async () => {
  const h = projectFixture(1); h.runtime.registerProjectSessionView('s', 'pr');
  await h.hydrate();
  h.messages.set('s', [row('new', 'edited without an event')]);
  await h.hydrate();
  assert.ok(h.state.events.s.some((e) => e.data.kind === 'message' && e.data.text === 'edited without an event'));
  h.messages.set('s', []); await h.hydrate();
  assert.equal(h.state.events.s.some((e) => e.data.kind === 'message'), false);
});

test('old daemon fallback is remembered once per method and reconnect retries projections', async () => {
  const h = createHarness(), supported = h.replies['session.history'];
  h.replies['session.history'] = () => { throw new Error('请求的资源不存在。'); };
  await settle(h, () => h.runtime.readSessionHistory('s'));
  await settle(h, () => h.runtime.readSessionHistory('s'));
  assert.equal(h.calls.filter((c) => c.method === 'session.history').length, 1);
  assert.equal(h.calls.filter((c) => c.method === 'session.get').length, 2);
  h.replies['session.history'] = supported; h.runtime.resetHistoryCapabilities();
  await settle(h, () => h.runtime.readSessionHistory('s'));
  assert.equal(h.calls.filter((c) => c.method === 'session.history').length, 2);
  assert.equal(h.calls.at(-1).params.cursor, undefined);
});

test('batch transport is bounded at 64, while per-session warm cursors remain independent', async () => {
  const h = projectFixture(130); h.runtime.registerProjectSessionView('s', 'pr');
  await h.hydrate(); const before = h.calls.length; await h.hydrate();
  const batch = h.calls.slice(before).filter((c) => c.method === 'session.historyBatch');
  assert.deepEqual(batch.map((c) => c.params.items.length), [64, 64, 2]);
  for (const request of batch.flatMap((c) => c.params.items)) assert.equal(request.cursor.scope, `messages:session:${request.sessionId}`);
  assert.equal(h.calls.filter((c) => c.method === 'session.get').length, 0);
});

test('a deleted peer in a batch does not disable projections for healthy sessions', async () => {
  const h = createHarness(), supported = h.replies['session.history'];
  h.replies['session.historyBatch'] = () => { throw new Error('请求的资源不存在。'); };
  h.replies['session.history'] = (params) => params.sessionId === 'gone' ? Promise.reject(new Error('请求的资源不存在。')) : supported(params);
  const legacy = h.replies['session.get'];
  h.replies['session.get'] = (params) => params.sessionId === 'gone' ? Promise.reject(new Error('missing session')) : legacy;
  let results;
  await settle(h, async () => { results = await Promise.allSettled(h.runtime.readSessionHistoryBatch(['s', 'gone']).values()); });
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  const before = h.calls.length; await settle(h, () => h.runtime.readSessionHistory('s'));
  assert.equal(h.calls.slice(before).filter((c) => c.method === 'session.history').length, 1);
  assert.equal(h.calls.slice(before).filter((c) => c.method === 'session.get').length, 0);
});

test('wrong-scope responses cannot advance a cursor or contaminate another session', async () => {
  const h = createHarness(); h.replies['session.history'] = () => ({ ...snapshot(h), cursor: { epoch: 'fixture', scope: 'messages:session:other', revision: 1 } });
  await assert.rejects(settle(h, () => h.runtime.readSessionHistory('s')), /Invalid history scope/);
  assert.equal(h.runtime.persistedHistory.size, 0);
});

for (const operation of ['hydrateStandaloneSession', 'refreshStandaloneSessionState']) {
  test(`late ${operation} cannot resurrect a deleted session`, async () => {
    const h = createHarness(); let release;
    h.replies['session.history'] = () => new Promise((resolve) => { release = resolve; });
    const pending = h.runtime[operation](h.session); await h.advance(100);
    assert.equal(typeof release, 'function');
    h.runtime.clearSessionRuntime('s'); h.state.sessions = [];
    release(snapshot(h)); await settle(h, () => pending);
    assert.equal(h.state.sessions.length, 0);
    assert.equal(h.runtime.standaloneMessageCache.has('s'), false);
    assert.equal(h.runtime.standaloneHydrated.has('s'), false);
    assert.equal(h.runtime.standaloneEventCache.has('s'), false);
    assert.equal(h.runtime.standaloneSequences.has('s'), false);
    assert.equal(h.runtime.persistedHistory.has('messages:session:s'), false);
  });
}

test('old generation history/replay cannot overwrite a recreated session with the same id', async () => {
  const h = createHarness(); let oldHistory, oldReplay;
  h.replies['session.history'] = () => new Promise((resolve) => { oldHistory = resolve; });
  h.replies['event.replay'] = () => new Promise((resolve) => { oldReplay = resolve; });
  const old = h.runtime.hydrateStandaloneSession(h.session); await h.advance(120);
  h.runtime.clearSessionRuntime('s'); h.state.sessions = [{ ...h.session, title: 'new generation' }];
  h.replies['session.history'] = () => ({ ...snapshot(h, 'new', 'new-epoch'), session: h.state.sessions[0] });
  h.replies['event.replay'] = { events: [], lastSequence: 2 };
  await settle(h, () => h.runtime.hydrateStandaloneSession(h.state.sessions[0]));
  oldHistory(snapshot(h, 'old')); oldReplay({ events: [delta(999, 'old stream')], lastSequence: 999 });
  await settle(h, () => old);
  assert.equal(h.state.sessions[0].title, 'new generation');
  assert.equal(h.runtime.standaloneMessageCache.get('s')[0].text, 'new');
  assert.equal(h.runtime.standaloneSequences.get('s'), 2);
  assert.equal(h.state.events.s.some((e) => e.data.text === 'old stream'), false);
});

test('deleting a project session during a batch never resurrects its metadata, view or cursor', async () => {
  const h = projectFixture(1); h.runtime.registerProjectSessionView('s', 'pr');
  const read = h.replies['session.historyBatch']; let release;
  h.replies['session.historyBatch'] = (params) => { const result = read(params); return new Promise((resolve) => { release = () => resolve(result); }); };
  const pending = h.runtime.hydrateProjectRun('pr'); await h.advance(220);
  h.runtime.clearSessionRuntime('s'); h.state.sessions = [];
  release(); await settle(h, () => pending);
  assert.equal(h.state.sessions.length, 0);
  assert.equal(h.runtime.projectSessionDetails.has('s'), false);
  assert.equal(h.runtime.projectSessionEventCache.has('s'), false);
  assert.equal(h.runtime.projectSessionSequences.has('s'), false);
  assert.equal(h.runtime.projectSessionBuilt.has('s'), false);
});

test('successful artifact/event cursors remain redrawable after a sibling metadata failure', async () => {
  const h = projectFixture(1); h.runtime.registerProjectSessionView('s', 'pr'); await h.hydrate();
  h.feeds.get('s').push(delta(1, 'new output'));
  h.setFailure('session.historyBatch'); await assert.rejects(h.hydrate(), /simulated/);
  h.setFailure(undefined); await h.hydrate();
  assert.ok(h.state.events.s.some((e) => e.data.text === 'new output'));
});

test('provider queue maps to queue activity, startup to starting, and only turn_started to thinking', () => {
  const h = createHarness();
  const events = ['provider_queued', 'provider_starting', 'turn_started'].map((phase, i) => delta(i + 1, '', { type: 'agent.status', payload: { phase } }));
  const timeline = h.runtime.buildStandaloneTimeline([], events, []);
  assert.deepEqual(Array.from(timeline, (e) => e.data.phase), ['provider_queued', 'starting', 'thinking']);
});

test('late authoritative queue response cannot recreate state for a deleted session', async () => {
  const h = createHarness(); let release;
  h.replies['session.followUp.list'] = () => new Promise((resolve) => { release = resolve; });
  const pending = h.runtime.hydrateStandaloneSession(h.session); await h.advance(200);
  h.runtime.clearSessionRuntime('s'); h.state.sessions = []; delete h.state.queuedFollowUps.s;
  release({ items: [{ messageId: 'old', text: 'old queue', queuedAt: h.session.createdAt }] });
  await settle(h, () => pending);
  assert.equal(h.state.queuedFollowUps.s, undefined);
  assert.equal(h.runtime.standaloneHydrated.has('s'), false);
});

test('a later persistence request reads after an in-flight snapshot instead of reusing stale rows', async () => {
  const h = createHarness(); let release; let count = 0;
  h.replies['session.history'] = () => ++count === 1 ? new Promise((resolve) => { release = resolve; }) : {
    ...snapshot(h, 'new'), reset: false, cursor: { epoch: 'fixture', scope: 'messages:session:s', revision: 2 }
  };
  const first = h.runtime.readSessionHistory('s'); await h.advance(50);
  const second = h.runtime.readSessionHistory('s'); await h.advance(50);
  assert.equal(count, 1, 'overlapping reads are serialized');
  release(snapshot(h, 'old'));
  let results; await settle(h, async () => { results = await Promise.all([first, second]); });
  assert.equal(count, 2); assert.equal(results[0].messages[0].text, 'old'); assert.equal(results[1].messages[0].text, 'new');
});

test('older standalone run metadata cannot overwrite a newer run hydration', async () => {
  const h = createHarness(); let oldRuns; let count = 0;
  h.replies['run.list'] = () => ++count === 1 ? new Promise((resolve) => { oldRuns = resolve; }) : [{ id: 'new-run', sessionId: 's', status: 'running' }];
  const first = h.runtime.hydrateStandaloneSession(h.session); await h.advance(100);
  h.replies['session.get'].messages = [row('new', 'new run text')];
  await settle(h, () => h.runtime.refreshStandaloneSessionState(h.session));
  oldRuns([{ id: 'old-run', sessionId: 's', status: 'running' }]); await settle(h, () => first);
  assert.equal(h.state.activeAgentRunIds.s, 'new-run');
  assert.equal(h.runtime.standaloneMessageCache.get('s')[0].text, 'new run text');
});
