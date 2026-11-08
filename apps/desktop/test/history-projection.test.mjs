import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, delta } from './helpers/orchestration-runtime-harness.mjs';
import { projectFixture, settle } from './helpers/project-poll-harness.mjs';
const clone = (value) => JSON.parse(JSON.stringify(value));
const row = (id, text = id, sessionId = 's') => ({ id, sessionId, sender: 'user', text, createdAt: '2026-11-03T00:00:00Z' });
const snapshot = (h, text = 'old', epoch = 'fixture') => ({ session: clone(h.session), reset: true, cursor: { epoch, scope: 'messages:session:s', revision: 1 }, items: [{ value: row('m', text), order: { createdAt: h.session.createdAt, ordinal: 1 } }] });

test('native history sync refreshes persisted rows even without a foreground run', async()=>{
  const h=createHarness();h.replies['run.list']=[];
  const waits=[];h.replies['event.wait']=()=>new Promise(resolve=>waits.push(resolve));
  const unregister=h.runtime.registerStandaloneSessionView('s');
  const hydrate=h.runtime.ensureStandaloneSessionHydrated('s');await h.advance(400);await hydrate;
  h.replies['session.get'].messages=[row('native-user','native input'),{...row('native-answer','native output'),sender:'agent'}];
  waits.shift()({events:[{schemaVersion:1,eventId:'native-sync',sequence:1,sessionId:'s',projectId:'p',timestamp:'2026-11-07T00:00:00Z',type:'session.native_history_synced',payload:{providerSessionId:'native',messageIds:['native-user','native-answer'],messageCount:2}}],lastSequence:1});
  await h.advance(400);
  assert.deepEqual(Array.from(h.runtime.standaloneMessageCache.get('s'),m=>m.id),['native-user','native-answer']);
  assert.ok(h.state.events.s.some(row=>row.data.kind==='message'&&row.data.text==='native output'));
  unregister();waits.shift()?.({events:[],lastSequence:1});await h.advance(100);
});

test('native edits retain the local row and missing native attachments remain visible',()=>{
  const h=createHarness();
  const messages=[{...row('local','native edit'),sender:'agent',runId:'r',nativeIdentity:{providerSessionId:'native',id:'native-part',source:'native-terminal',completed:true},nativeFiles:[{id:'missing',name:'missing.txt',unavailable:true}]}];
  const events=[{schemaVersion:1,eventId:'old-completion',sequence:1,sessionId:'s',projectId:'p',runId:'r',timestamp:'2026-11-03T00:00:00Z',type:'agent.message',payload:{messageId:'local',providerMessageId:'native-part',text:'before native edit'}}];
  const rows=h.runtime.buildStandaloneTimeline(messages,events,[]).filter(row=>row.data.kind==='message');
  assert.equal(rows.length,1);assert.equal(rows[0].data.text,'native edit');
  assert.equal(rows[0].data.attachments[0].name,'missing.txt');assert.equal(rows[0].data.attachments[0].unavailable,true);
});

test('native partial replies stream while running and stop after cancellation',()=>{
  const h=createHarness();
  const message={...row('native-partial','retained prefix'),sender:'agent',runId:'native-run',nativeIdentity:{providerSessionId:'native',id:'part',source:'native-terminal',completed:false,turnStatus:'running'}};
  assert.equal(h.runtime.buildStandaloneTimeline([message],[],[]).find(row=>row.data.kind==='message').data.streaming,true);
  message.nativeIdentity.turnStatus='cancelled';
  const cancelled=h.runtime.buildStandaloneTimeline([message],[],[]).find(row=>row.data.kind==='message');
  assert.equal(cancelled.data.streaming,false);assert.equal(cancelled.data.text,'retained prefix');
});

test('a native completion supersedes an earlier reconstructed cancellation',()=>{
  const h=createHarness();const message={...row('native-final','native reply'),sender:'agent',runId:'r',nativeIdentity:{providerSessionId:'native',id:'part',source:'native-terminal',completed:true,turnStatus:'completed'}};
  const base={schemaVersion:1,sessionId:'s',projectId:'p',runId:'r',timestamp:'2026-11-07T03:13:20Z'};
  const cancelled={...base,eventId:'interim-cancelled',sequence:1,type:'run.cancelled',payload:{reason:'native-terminal'}};
  const completed={...base,eventId:'actual-completion',sequence:2,type:'run.completed',payload:{summary:''}};
  const corrected=h.runtime.buildStandaloneTimeline([message],[cancelled,completed],[]);
  assert.equal(corrected.some(row=>row.data.kind==='activity'&&row.data.phase==='stopped'),false);
  const stopped=h.runtime.buildStandaloneTimeline([message],[cancelled],[]);
  assert.equal(stopped.some(row=>row.data.kind==='activity'&&row.data.phase==='stopped'),true);
});

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
