import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './helpers/orchestration-runtime-harness.mjs';
const event=(sequence,type,payload,background=false)=>({schemaVersion:1,eventId:`e${sequence}`,sequence,sessionId:'s',projectId:'p',runId:'r',timestamp:`2026-11-06T00:00:0${sequence}Z`,type,payload,background});
const flatten=(events)=>events.flatMap(row=>row.data.kind==='tool_group'?flatten(row.data.items):[row]);
test('foreground completion cannot finalize background tool and reasoning streams',()=>{
  const h=createHarness();
  const events=[event(1,'run.completed',{summary:'done'}),event(2,'tool.started',{callId:'bg',toolName:'Read'},true),event(3,'agent.thinking_delta',{messageId:'bg-think',text:'still running'},true)];
  let rows=flatten(h.runtime.buildStandaloneTimeline([],events,[]));
  assert.equal(rows.find(row=>row.data.kind==='tool_activity').data.status,'running');
  assert.equal(rows.find(row=>row.data.kind==='reasoning').data.streaming,true);
  rows=flatten(h.runtime.buildStandaloneTimeline([],[...events,event(4,'tool.finished',{callId:'bg',toolName:'Read',success:true},true),event(5,'agent.thinking_summary',{messageId:'bg-think',text:'finished'},true)],[]));
  assert.equal(rows.find(row=>row.data.kind==='tool_activity').data.status,'done');
  assert.equal(rows.find(row=>row.data.kind==='reasoning').data.streaming,false);
});

test('an open completed conversation keeps its event subscription for background updates',async()=>{
  const h=createHarness();
  h.replies['run.list']=[{id:'r',sessionId:'s',status:'completed'}];
  const waits=[];h.replies['event.wait']=()=>new Promise(resolve=>waits.push(resolve));
  const unregister=h.runtime.registerStandaloneSessionView('s');
  const hydrate=h.runtime.ensureStandaloneSessionHydrated('s');await h.advance(400);await hydrate;
  assert.equal(waits.length,1,'completed foreground must still listen while displayed');
  waits.shift()({events:[event(1,'run.completed',{summary:'done'}),event(2,'tool.started',{callId:'bg',toolName:'Read'},true)],lastSequence:2});
  await h.advance(400);
  const rows=flatten(h.state.events.s);
  assert.equal(rows.find(row=>row.data.kind==='tool_activity').data.status,'running');
  assert.equal(waits.length,1,'session stays subscribed after receiving background work');
  unregister();waits.shift()({events:[],lastSequence:2});await h.advance(100);
});

test('completed team sessions listen with their own cursor instead of stopping with the project run',async()=>{
  const h=createHarness();h.session.projectRunId='pr';
  const waits=[];h.replies['event.wait']=()=>new Promise(resolve=>waits.push(resolve));
  let refreshes=0;h.runtime.setTestProjectHydrator(async()=>{refreshes++;return{id:'pr',status:'completed',mainSessionId:'s'};});
  h.runtime.projectSessionSequences.set('s',17);
  const unregister=h.runtime.registerProjectSessionView('s','pr');
  const hydrate=h.runtime.ensureProjectRunHydrated('pr');await h.advance(100);await hydrate;
  assert.equal(waits.length,1);
  assert.equal(h.calls.find(call=>call.method==='event.wait').params.afterSequence,17);
  waits.shift()({events:[event(18,'tool.finished',{callId:'bg',toolName:'Read',success:true},true)],lastSequence:18});
  await h.advance(100);
  assert.equal(refreshes,2,'late native output refreshes a completed team conversation');
  unregister();waits.shift()({events:[],lastSequence:18});await h.advance(100);
});
