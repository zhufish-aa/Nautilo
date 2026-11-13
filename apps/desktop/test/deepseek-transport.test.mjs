import test from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../../../rust/plugins/deepseek/resources/bridge.mjs';

test('DSH binds a temporary connection once through native volatile updates and keeps persisted options', async (t) => {
  const oldToken = process.env.NAUTILO_DSH_TOKEN;
  process.env.NAUTILO_DSH_TOKEN = 'binding-fixture';
  const storedConfig = { providers: { native: { apiKeyEnv: 'NATIVE_KEY' } } };
  const connection = { provider: 'nautilo-account', profile: { apiKeyEnv: 'TEMPORARY_KEY', baseURL: 'http://127.0.0.1:12345/v1' } };
  let providers = structuredClone(storedConfig.providers);
  let updates = 0;
  let waitCount = 0;
  const entry = {
    options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: storedConfig },
    fiber: {
      config: { providers: { get: () => providers } },
      update() { assert.fail('Binding a provider must use the native volatile path'); },
    },
    async update(options) {
      updates++;
      this.options.config = options.config;
      providers = structuredClone(options.config.providers);
    },
  };
  const cleanup = [];
  const agents = new Map();
  const ctx = {
    on() {}, get() {}, tools: { register() {} },
    effect(fn) { const dispose = fn(); if (dispose) cleanup.push(dispose); },
    loader: { entries: () => [entry], async await() { waitCount++; } },
    workspaceRegistry: { async create() { return { id: 'workspace' }; } },
    sessionController: {
      async create({ sessionId }) {
        agents.set(sessionId, { session: { id: sessionId, header: {} }, ctx: {} });
        return { sessionId };
      },
      async resolveAgent(sessionId) { return { agent: agents.get(sessionId) }; },
    },
    agentPresets: { composedPreset: () => 'standard', serviceFor() {} },
    permissionPresets: { current: () => 'ask' },
  };
  let port;
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('@nautilo-dsh:')) {
      const frame = JSON.parse(chunk.slice('@nautilo-dsh:'.length));
      if (frame.kind === 'ready') port = frame.port;
      args.find(value => typeof value === 'function')?.();
      return true;
    }
    return write.call(this, chunk, ...args);
  };
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    process.stdout.write = write;
    if (oldToken === undefined) delete process.env.NAUTILO_DSH_TOKEN;
    else process.env.NAUTILO_DSH_TOKEN = oldToken;
  });
  await apply(ctx, { connection });
  const open = async (sessionId) => {
    const response = await fetch(`http://127.0.0.1:${port}/open`, {
      method: 'POST',
      headers: { authorization: 'Bearer binding-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd: process.cwd() }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await open('first');
  const second = await open('second');
  assert.equal(updates, 1);
  assert.equal(waitCount, 2, 'Native readiness is awaited only during the initial binding');
  assert.equal(entry.options.config, storedConfig);
  assert.deepEqual(providers.native, storedConfig.providers.native);
  assert.deepEqual(providers[connection.provider], connection.profile);
  assert.equal(typeof first.timings.loaderWaitMs, 'number');
  assert.equal(second.timings.loaderWaitMs, undefined, 'Reuse must not report the first startup timings again');
});

test('DSH questions claim Nautilo-owned sessions before native remotes and round-trip choices, text and cancellation',async()=>{
  const token='fixture-token',oldToken=process.env.NAUTILO_DSH_TOKEN;
  process.env.NAUTILO_DSH_TOKEN=token;
  const frames=[],cleanup=[],hooks=new Map(),agents=new Map();let forwarded=0;
  hooks.set('user-questions/request',[async()=>{forwarded++;return{answers:[{id:'native',selected:['native UI']}]}}]);
  const ctx={
    on(name,fn,options){const listeners=hooks.get(name)??[];if(options===true||options?.prepend)listeners.unshift(fn);else listeners.push(fn);hooks.set(name,listeners)},
    effect(fn){const dispose=fn();if(dispose)cleanup.push(dispose)},get(){},tools:{register(){}},
    workspaceRegistry:{async create(){return{id:'workspace'}}},
    sessionController:{async create({sessionId}){agents.set(sessionId,{session:{id:sessionId,header:{}},ctx:{}});return{sessionId}},async resolveAgent(id){return{agent:agents.get(id)}}},
    agentPresets:{composedPreset(){return'standard'},serviceFor(){}},permissionPresets:{current(){return'ask'}}
  };
  const fire=(name,request)=>{const list=[...(hooks.get(name)??[])];const next=()=>{const fn=list.shift();return fn?fn(request,next):Promise.reject(new Error('No answerer'))};return next()};
  const write=process.stdout.write;
  process.stdout.write=function(chunk,...args){if(typeof chunk==='string'&&chunk.startsWith('@nautilo-dsh:')){frames.push(JSON.parse(chunk.slice('@nautilo-dsh:'.length)));const callback=args.find(value=>typeof value==='function');callback?.();return true}return write.call(this,chunk,...args)};
  try{
    await apply(ctx);
    const port=frames.find(frame=>frame.kind==='ready').port;
    const post=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return response.json()};
    await post('/open',{cwd:process.cwd(),sessionId:'owned'});
    const originalAgent=agents.get('owned');
    const publish=(agent,type,attemptId='owned:1')=>{
      fire('agent/assistant-stream',{agent,frame:{type,attemptId,chunk:{type:'text-delta',index:0,text:'reply'}}});
      return frames.at(-1);
    };
    const first=publish(originalAgent,'start');
    const delta=publish(originalAgent,'chunk');
    assert.equal(first.frame.attemptId,delta.frame.attemptId,'one native attempt keeps its identity across all frames');
    assert.notEqual(first.frame.attemptId,'owned:1','agent-local counters are not treated as session-global IDs');
    const replacementAgent={session:originalAgent.session,ctx:{}};
    const resumed=publish(replacementAgent,'start');
    assert.notEqual(resumed.frame.attemptId,first.frame.attemptId,'resuming the same session with a reset counter cannot reuse an earlier reply ID');
    assert.equal(publish(originalAgent,'end').frame.attemptId,first.frame.attemptId,'late frames keep their originating identity');
    assert.equal(publish(replacementAgent,'chunk').frame.attemptId,resumed.frame.attemptId,'new replies remain bound to the resumed agent');
    const request={agent:agents.get('owned'),signal:new AbortController().signal,questions:[{id:'pick',header:'选择',question:'做什么？',detail:'更多信息',multiSelect:true,options:[{label:'检查',description:'检查代码'},{label:'修复'}]}]};
    const pending=fire('user-questions/request',request);
    const frame=frames.findLast(frame=>frame.kind==='question');assert.ok(frame,'native request becomes a UI question, not just a tool JSON block');assert.equal(forwarded,0);
    assert.equal(frame.questions[0].question,'做什么？\n\n更多信息');assert.equal(frame.questions[0].isOther,true);assert.equal(frame.questions[0].multiSelect,true);assert.equal(frame.questions[0].options[0].description,'检查代码');
    await post('/answer',{id:frame.id,answer:{outcome:'selected',answers:{pick:['检查','修复','自定义回答']}}});
    assert.deepEqual(await pending,{answers:[{id:'pick',selected:['检查','修复'],custom:'自定义回答'}]});
    const unowned=await fire('user-questions/request',{...request,agent:{session:{id:'outside'}}});assert.equal(forwarded,1);assert.equal(unowned.answers[0].id,'native');
    const controller=new AbortController();const aborted=fire('user-questions/request',{...request,signal:controller.signal});const abortedId=frames.findLast(frame=>frame.kind==='question').id;controller.abort();await assert.rejects(aborted,/cancelled/i);assert.ok(frames.some(frame=>frame.kind==='interaction_cancel'&&frame.id===abortedId));
  }finally{
    for(const dispose of cleanup.reverse())await dispose();process.stdout.write=write;
    if(oldToken===undefined)delete process.env.NAUTILO_DSH_TOKEN;else process.env.NAUTILO_DSH_TOKEN=oldToken;
  }
});
