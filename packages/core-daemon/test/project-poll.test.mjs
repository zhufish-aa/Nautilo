import test from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../dist/database/index.js';
import { EventService } from '../dist/runtime/event-service.js';
import { readProjectPoll, projectPollHealIds } from '../dist/database/project-poll.js';
const time='2026-11-03T00:00:00Z';
function fixture(t,n=2){
 const db=new Database(':memory:');t.after(()=>db.close());
 db.projectRuns.save({id:'pr',projectId:'p',teamId:'t',mainSessionId:'s',status:'executing',createdAt:time,updatedAt:time});
 for(let i=0;i<n;i++){const id=i?`s${i}`:'s';db.sessions.save({id,projectId:'p',projectRunId:'pr',parentSessionId:i?'s':undefined,memberId:'a',status:'running',createdAt:time,updatedAt:time});db.sessions.saveMessage({id:`m${i}`,sessionId:id,sender:'user',text:`history${i}`,createdAt:time});}
 return db;
}
const next=(snapshot)=>({projectRunId:'pr',visibleSessionIds:['s'],artifactCursor:snapshot.artifacts.cursor,sessions:snapshot.sessions.map(s=>({sessionId:s.id,eventCursor:snapshot.feeds.find(f=>f.sessionId===s.id).cursor,historyCursor:snapshot.histories.find(h=>h.session.id===s.id)?.cursor}))});
function event(id,seq,type='command.finished',timestamp=time){return{schemaVersion:1,eventId:id,sessionId:'s',projectId:'p',projectRunId:'pr',runId:'r',sequence:seq,type,timestamp,payload:{messageId:'thinking',text:id}};}

test('one project snapshot contains scoped metadata, independent cursors and only changed rows',t=>{
 const db=fixture(t);db.sessions.save({id:'foreign',projectId:'p',projectRunId:'other',memberId:'a',createdAt:time,updatedAt:time,status:'running'});
 db.events.append(event('e1',1));const first=readProjectPoll(db,{projectRunId:'pr',visibleSessionIds:['s','foreign']});
 assert.equal(first.sessions.length,2);assert.equal(first.histories.length,2);assert.equal(first.feeds[0].events.length,1);
 const warm=readProjectPoll(db,next(first));assert.ok(warm.histories.every(h=>!h.reset&&!h.items.length));assert.ok(warm.feeds.every(f=>!f.reset&&!f.events.length));
 db.sessions.saveMessage({id:'m0',sessionId:'s',sender:'user',text:'edited',createdAt:time});
 assert.equal(readProjectPoll(db,next(warm)).histories.find(h=>h.session.id==='s').items[0].value.text,'edited');
});
test('old delta retention with unchanged max sequence resets the event projection',t=>{
 const db=fixture(t,1);db.events.append(event('old',1,'agent.thinking_delta','2026-11-01'));db.events.append(event('keep',2));
 const first=readProjectPoll(db,{projectRunId:'pr'});db.events.deleteBefore('2026-11-02');
 const changed=readProjectPoll(db,next(first));assert.equal(changed.feeds[0].reset,true);assert.deepEqual(changed.feeds[0].events.map(e=>e.eventId),['keep']);
});
test('coalescing has an explicit transaction guard and never resets or loses accumulated text',t=>{
 const db=fixture(t,1),service=new EventService(db),s=db.sessions.get('s');
 service.appendForSession(s,{runId:'r',projectRunId:'pr'},'agent.thinking_delta',{messageId:'thinking',text:'A'});
 const first=readProjectPoll(db,{projectRunId:'pr'});
 service.appendForSession(s,{runId:'r',projectRunId:'pr'},'agent.thinking_delta',{messageId:'thinking',text:'B'});
 const changed=readProjectPoll(db,next(first));assert.equal(changed.feeds[0].reset,false);assert.equal(changed.feeds[0].events[0].payload.text,'AB');
 assert.equal(db.connection.raw.prepare('SELECT COUNT(*) AS n FROM read_projection_event_coalescing').get().n,0);
 const append=db.events.append;db.events.append=()=>{throw new Error('failure after replacement delete');};
 assert.throws(()=>service.appendForSession(s,{runId:'r'},'agent.thinking_delta',{messageId:'thinking',text:'C'}),/failure/);db.events.append=append;
 assert.equal(db.connection.raw.prepare('SELECT COUNT(*) AS n FROM read_projection_event_coalescing').get().n,0);assert.equal(db.events.replay({sessionId:'s'})[0].payload.text,'AB');
});
test('rewind with reused sequence and changed epoch resets; foreign cursors cannot leak scope',t=>{
 const db=fixture(t);db.events.append(event('old',1));const first=readProjectPoll(db,{projectRunId:'pr',visibleSessionIds:['s']});
 db.connection.raw.exec("DELETE FROM runtime_events WHERE session_id='s'");db.events.append(event('new',1));
 const changed=readProjectPoll(db,next(first));assert.equal(changed.feeds[0].reset,true);assert.equal(changed.feeds[0].events[0].eventId,'new');
 const input=next(changed);input.sessions[0].eventCursor.scope='events:session:foreign';input.sessions[1].historyCursor=changed.histories[0].cursor;
 const isolated=readProjectPoll(db,input);assert.equal(isolated.feeds[0].reset,true);assert.equal(isolated.histories[1].reset,true);assert.equal(isolated.histories[1].items[0].value.sessionId,'s1');
});
test('stale deleted cursor entries are ignored without invalidating other sessions',t=>{
 const db=fixture(t);const first=readProjectPoll(db,{projectRunId:'pr',visibleSessionIds:['s']});db.sessions.deleteTree('s1');
 const changed=readProjectPoll(db,next(first));assert.deepEqual(changed.sessions.map(s=>s.id),['s']);assert.equal(changed.histories[0].reset,false);assert.deepEqual(changed.histories[0].items,[]);
});
test('initial and warm aggregation are bounded to 64 sessions; larger projects use legacy hydration',t=>{
 const db=fixture(t,65);const result=readProjectPoll(db,{projectRunId:'pr',visibleSessionIds:['s']});assert.equal(result.fallback,true);assert.equal(result.histories,undefined);assert.deepEqual(projectPollHealIds(db,{projectRunId:'pr'}),[]);
 assert.throws(()=>readProjectPoll(db,{projectRunId:'pr',sessions:Array.from({length:2049},()=>({sessionId:'s'}))}),/IPC_INVALID_REQUEST|请求/);
});
