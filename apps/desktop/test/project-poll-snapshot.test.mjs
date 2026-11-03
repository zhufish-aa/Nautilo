import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFixture,settle } from './helpers/project-poll-harness.mjs';
import { delta } from './helpers/orchestration-runtime-harness.mjs';
const fixture=(count=21)=>{const h=projectFixture(count,undefined,{aggregated:true});h.runtime.registerProjectSessionView('s','pr');return h;};

test('21-session warm snapshot uses one IPC/40ms with no unchanged history rebuild',async()=>{
 const h=fixture();await h.hydrate();const before=h.calls.length,renders=h.renders.length,time=h.now();await h.hydrate();
 assert.deepEqual(h.calls.slice(before).map(c=>c.method),['projectRun.poll']);assert.equal(h.now()-time,40);assert.equal(h.renders.length,renders);
 assert.ok(h.calls.at(-1).params.sessions.every(s=>s.historyCursor&&s.eventCursor));
});
test('new child and same-timestamp edits are hydrated; cross-run first output remains immediate',async()=>{
 const h=fixture(1);await h.hydrate();h.messages.get('s')[0].text='same timestamp edit';h.feeds.get('s').push(delta(1,'first new token',{runId:'next'}));
 await h.hydrate();assert.ok(h.state.events.s.some(e=>e.data.text==='same timestamp edit'));assert.ok(h.state.events.s.some(e=>e.data.text==='first new token'));
});
test('earlier empty queue cannot overwrite a newer queued event and cursor advancement',async()=>{
 const h=fixture(1),poll=h.replies['projectRun.poll'];h.feeds.get('s').push(delta(1,'',{type:'session.follow_up_queued',payload:{messageId:'q',text:'queued'}}));
 h.replies['projectRun.poll']=(input)=>{const result=poll(input);if(!input.sessions[0].eventCursor)result.followUps=[{sessionId:'s',afterSequence:0,items:[]}];return result;};
 await h.hydrate();assert.deepEqual(h.state.queuedFollowUps.s.map(q=>q.messageId),['q']);await h.hydrate();assert.deepEqual(h.state.queuedFollowUps.s.map(q=>q.messageId),['q']);
});
test('authoritative queue plus run transition does not shift the next queued item twice',async()=>{
 const h=fixture(1);await h.hydrate();h.runs.unshift({id:'next',sessionId:'s',status:'running'});const poll=h.replies['projectRun.poll'];
 h.replies['projectRun.poll']=(input)=>({...poll(input),followUps:[{sessionId:'s',afterSequence:0,items:[{messageId:'next-q',text:'next queued',queuedAt:h.session.createdAt}]}]});
 await h.hydrate();assert.equal(h.state.activeAgentRunIds.s,'next');assert.deepEqual(h.state.queuedFollowUps.s.map(q=>q.messageId),['next-q']);
});
test('event reset removes cached reasoning after deletion even with unchanged max sequence',async()=>{
 const h=fixture(1);h.feeds.get('s').push(delta(1,'old reasoning',{type:'agent.thinking_delta'}),delta(2,'',{type:'run.started',payload:{runId:'r'}}));await h.hydrate();
 assert.ok(h.state.events.s.some(e=>e.data.kind==='reasoning'));h.feeds.set('s',[h.feeds.get('s')[1]]);const poll=h.replies['projectRun.poll'];
 h.replies['projectRun.poll']=(input)=>{const result=poll(input);result.feeds[0].reset=true;result.feeds[0].events=h.feeds.get('s');result.followUps=[{sessionId:'s',afterSequence:2,items:[]}];return result;};
 await h.hydrate();assert.equal(h.state.events.s.some(e=>e.data.kind==='reasoning'),false);assert.deepEqual(Array.from(h.runtime.projectSessionEventCache.get('s'),e=>e.eventId),['e2']);
});
test('late snapshot cannot resurrect a deleted/recreated session generation',async()=>{
 const h=fixture(1),poll=h.replies['projectRun.poll'];let release;h.replies['projectRun.poll']=(input)=>{const response=poll(input);return new Promise(resolve=>{release=()=>resolve(response);});};
 const pending=h.runtime.hydrateProjectRun('pr');await h.advance(50);h.runtime.clearSessionRuntime('s');h.state.sessions=[];release();await settle(h,()=>pending);
 assert.equal(h.state.sessions.length,0);assert.equal(h.runtime.projectEventCursors.has('s'),false);assert.equal(h.runtime.projectSessionDetails.has('s'),false);
});
test('transient failures do not disable the endpoint; malformed scopes commit nothing',async()=>{
 const h=fixture(1),poll=h.replies['projectRun.poll'];h.replies['projectRun.poll']=()=>{throw new Error('temporary transport failure');};await assert.rejects(h.hydrate(),/temporary/);assert.equal(h.calls.some(c=>c.method==='projectRun.get'),false);
 h.replies['projectRun.poll']=(input)=>{const result=poll(input);result.feeds[0].cursor.scope='events:session:foreign';return result;};await assert.rejects(h.hydrate(),/Invalid projectRun.poll scope/);assert.equal(h.runtime.projectEventCursors.size,0);
 h.replies['projectRun.poll']=poll;await h.hydrate();assert.equal(h.state.sessions[0].id,'s');
});

test('epoch/reset rebuilds the real interaction store per session and invalidates queue/commands',async()=>{
 const {readFileSync}=await import('node:fs');const {createRequire}=await import('node:module');const {default:vm}=await import('node:vm');const {default:ts}=await import('typescript');
 const require=createRequire(new URL('../package.json',import.meta.url));const interactionsModule={};
 const source=readFileSync(new URL('../src/renderer/src/stores/interactions.ts',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:interactionsModule,require:(name)=>name==='zustand'?require('zustand'):{getBridge:()=>undefined}});
 const h=projectFixture(1,undefined,{aggregated:true,interactionsModule});h.runtime.registerProjectSessionView('s','pr');
 const interaction={id:'q',sessionId:'s',kind:'question',status:'pending',createdAt:h.session.createdAt};
 interactionsModule.useInteractionsStore.getState()._upsert({...interaction,id:'other-q',sessionId:'other'});
 h.feeds.get('s').push(delta(1,'',{type:'interaction.requested',payload:{interaction}}));await h.hydrate();
 assert.equal(interactionsModule.useInteractionsStore.getState().bySession.s[0].status,'pending');
 h.state.queuedFollowUps.s=[{messageId:'old',text:'old'}];h.feeds.set('s',[]);await h.hydrate();
 assert.equal(interactionsModule.useInteractionsStore.getState().bySession.s,undefined);assert.equal(interactionsModule.useInteractionsStore.getState().bySession.other[0].id,'other-q');
 assert.equal(h.state.queuedFollowUps.s.length,0);assert.equal(h.state.providerCommandRevisions.s,2);
 interactionsModule.useInteractionsStore.getState()._upsert({...interaction,status:'resolved'});const poll=h.replies['projectRun.poll'];
 h.replies['projectRun.poll']=(input)=>{const r=poll(input);r.feeds[0].reset=true;r.feeds[0].events=[delta(1,'',{type:'interaction.requested',payload:{interaction}})];r.followUps=[{sessionId:'s',afterSequence:1,items:[]}];return r;};
 await h.hydrate();assert.equal(interactionsModule.useInteractionsStore.getState().bySession.s[0].status,'pending');
});

test('snapshot to legacy protocol transition resets old DB sequence and sees new sequence one immediately',async()=>{
 const h=fixture(1);h.feeds.get('s').push(delta(100,'old DB answer'));await h.hydrate();
 h.feeds.set('s',[delta(1,'new DB answer',{eventId:'new-e1'})]);h.replies['projectRun.poll']=()=>{throw new Error('unknown method projectRun.poll');};
 const before=h.calls.length;await h.hydrate();
 assert.ok(h.calls.slice(before).some(c=>c.method==='event.replay'&&c.params.afterSequence===0));
 assert.ok(h.state.events.s.some(e=>e.data.text==='new DB answer'));assert.equal(h.state.events.s.some(e=>e.data.text==='old DB answer'),false);
 assert.equal(h.runtime.projectSessionSequences.get('s'),1);assert.equal(h.runtime.projectEventCursors.has('s'),false);
});

test('pending interaction authority survives journal retention and newer resolution wins its watermark',async()=>{
 const {readFileSync}=await import('node:fs');const {createRequire}=await import('node:module');const {default:vm}=await import('node:vm');const {default:ts}=await import('typescript');
 const require=createRequire(new URL('../package.json',import.meta.url));const interactionsModule={};
 vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/renderer/src/stores/interactions.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:interactionsModule,require:(name)=>name==='zustand'?require('zustand'):{getBridge:()=>undefined}});
 const h=projectFixture(1,undefined,{aggregated:true,interactionsModule});h.runtime.registerProjectSessionView('s','pr');const poll=h.replies['projectRun.poll'];
 const interaction={id:'active',sessionId:'s',kind:'question',status:'pending',createdAt:h.session.createdAt};
 h.replies['projectRun.poll']=(input)=>{const result=poll(input);result.feeds[0].reset=true;result.followUps=[{sessionId:'s',afterSequence:0,items:[],interactions:[interaction]}];return result;};
 await h.hydrate();assert.equal(interactionsModule.useInteractionsStore.getState().bySession.s[0].status,'pending');
 h.feeds.get('s').push(delta(1,'',{type:'interaction.resolved',payload:{interaction:{...interaction,status:'resolved'}}}));
 await h.hydrate();assert.equal(interactionsModule.useInteractionsStore.getState().bySession.s[0].status,'resolved');
});
