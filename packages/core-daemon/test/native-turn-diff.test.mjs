import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterRegistry, Database, EventService, RunService } from '../dist/index.js';
import { startCodexAppServer } from '../dist/adapters/codex/app-server-run.js';
import { parseCodexAppServerNotification, isCurrentCodexTurnDiff } from '../dist/adapters/codex/app-server-events.js';

const now = new Date().toISOString();
const instance = { id: 'native-agent', providerId: 'fake', displayName: 'Fake', executable: process.execPath, baseArgs: [], capabilities: [], enabled: true, status: 'available', createdAt: now, updatedAt: now };
const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';

test('native turn diff parser accepts empty snapshots, rejects malformed values, scopes exact thread/turn', () => {
  assert.equal(parseCodexAppServerNotification('turn/diff/updated', { diff: '', threadId: 't', turnId: 'u' })[0].diff, '');
  assert.deepEqual(parseCodexAppServerNotification('turn/diff/updated', { diff: null, threadId: 't', turnId: 'u' }), []);
  assert.equal(isCurrentCodexTurnDiff({ threadId: 't', turnId: 'u' }, 't', 'u'), true);
  for (const params of [{ threadId: 'child', turnId: 'u' }, { threadId: 't', turnId: 'old' }, {}]) {
    assert.equal(isCurrentCodexTurnDiff(params, 't', 'u'), false);
  }
});

test('actual JSON-RPC pump ignores child/stale diff and completion notifications', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-native-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'app-server'), `
const rl=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line); if(q.id===undefined)return;
 if(q.method==='initialize')return send({id:q.id,result:{}});
 if(q.method==='thread/start')return send({id:q.id,result:{thread:{id:'main'}}});
 if(q.method==='turn/start'){
  send({id:q.id,result:{turn:{id:'current'}}});
  const emit=(method,params)=>send({method,params});
  emit('turn/diff/updated',{threadId:'main',turnId:'current',diff:'first'});
  emit('turn/completed',{threadId:'child',turn:{id:'child-turn'}});
  emit('turn/diff/updated',{threadId:'child',turnId:'current',diff:'wrong child'});
  emit('turn/completed',{threadId:'main',turn:{id:'old'}});
  emit('turn/diff/updated',{threadId:'main',turnId:'current',diff:'replacement'});
  emit('turn/diff/updated',{threadId:'main',turnId:'current',diff:''});
  emit('turn/diff/updated',{threadId:'main',turnId:'old',diff:'stale resurrection'});
  emit('turn/completed',{threadId:'main',turn:{id:'current'}});
 }
});`);
  const run = startCodexAppServer({ instance: { ...instance, providerId: 'codex' }, cwd: root, prompt: 'test', env: { PATH: process.env.PATH }, timeoutMs: 3000 }, false);
  const events = [];
  for await (const event of run.events) events.push(event);
  assert.deepEqual(events.filter((event) => event.kind === 'turn_diff').map((event) => event.diff), ['first', 'replacement', '']);
  assert.equal(events.filter((event) => event.kind === 'exit').length, 1);
});

for (const mode of ['off', 'full']) {
  test(`native snapshots replace stable per-run artifact, preserve append-only replay and ${mode} policy`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nautilo-native-run-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'a.txt'), 'old\n');
    const db = new Database(':memory:'); t.after(() => db.close());
    const eventService = new EventService(db);
    const observed = []; eventService.onAppend((event) => { if(event.type === 'run.diff_updated') observed.push(event); });
    const adapter = { providerId:'fake', supportsResume:false, capabilities:{nativeResume:false}, start: (request) => {
      async function* events() {
        await writeFile(join(root, 'a.txt'), 'new\n');
        yield {kind:'file',path:'a.txt',changeType:'modified',diff:patch};
        for (const diff of [patch, patch, patch + '\n', '']) yield {kind:'turn_diff',diff,threadId:'main',turnId:'current'};
        yield {kind:'file',path:'a.txt',changeType:'modified',diff:patch}; // old item after clear must not revive native artifact
        yield {kind:'exit',exitCode:0};
      }
      return {events:events(),cancel:async()=>{},write:()=>{}};
    }};
    const service = new RunService(db,new AdapterRegistry([adapter]),eventService);
    const project = {id:'p',name:'P',rootPath:root,repositoryType:'none',nonGitDiffMode:mode,frontendPaths:[],backendPaths:[],ignoredPaths:[],policyId:'default'};
    const session = {id:'s',projectId:'p',memberId:instance.id,title:'Native',status:'idle',unreadCount:0,createdAt:now,updatedAt:now};
    db.projects.save(project,now);db.sessions.save(session);
    const run = await service.launch(session,instance,'test'); await run.completion;
    const native = db.artifacts.get('native-diff:'+run.runId);
    assert.equal(JSON.parse(native.content).diff,'');
    assert.equal(native.metadata.source,'provider');
    const artifacts=db.artifacts.list({sessionId:'s'});
    assert.equal(artifacts.filter((a)=>a.metadata?.source==='provider').length,1);
    assert.equal(artifacts.filter((a)=>a.metadata?.source==='filesystem').length,mode==='full'?1:0);
    assert.equal(observed.length,3);
    assert.ok(observed.every((event,i)=>i===0||event.sequence>observed[i-1].sequence));
    assert.equal(db.events.replay({sessionId:'s'}).filter((event)=>event.type==='run.diff_updated').length,3);
    const afterFirst=db.events.replay({sessionId:'s',afterSequence:observed[0].sequence}).filter((event)=>event.type==='run.diff_updated');
    assert.deepEqual(afterFirst.map((event)=>event.payload.diff),[patch+'\n','']);
    // A second run cannot mutate the first run's stable artifact.
    const second=await service.launch(db.sessions.get('s'),instance,'again');await second.completion;
    assert.notEqual(second.runId,run.runId);
    assert.equal(db.artifacts.get('native-diff:'+run.runId).metadata.runId,run.runId);
    assert.equal(db.artifacts.list({sessionId:'s'}).filter((a)=>a.metadata?.source==='provider').length,2);
  });
}
