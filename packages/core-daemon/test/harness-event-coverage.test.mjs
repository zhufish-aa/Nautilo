import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCodePartStream, parseOpenCodeEvent, withOpenCodeSubagentDispatch, openCodeImagePart } from '../../provider-plugin-opencode/dist/index.js';
import { buildOpenSourceConfiguration } from '../../provider-plugin-trae/dist/index.js';
import { TurnUsage } from '../../provider-plugin-pi/dist/usage.js';
import { imagePromptBlocks, promptWithImageFiles } from '../dist/adapters/images.js';
import { mergeCliArgs, streamEvents } from '../dist/adapters/process-adapter.js';
import { buildCodexTurnStartParams } from '../dist/adapters/codex/app-server-run.js';
import { inheritNativeResources } from '../../provider-sdk/dist/index.js';
import { applyConfig } from '../dist/adapters/kimi/acp-run.js';
import { childEvents } from '../../provider-plugin-pi/dist/subagents.js';
import { subagentMeta } from '../dist/runtime/subagent-detection.js';
import { resolveCodexInvocation } from '../dist/adapters/codex/executable.js';

test('configured node or wrapper is not replaced with a Codex installation on PATH', t => {
  const root=mkdtempSync(join(tmpdir(),'nautilo-executable-choice-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,'node_modules','@openai','codex','bin');
  mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'codex.js'),'fixture');
  for (const executable of ['node','custom-wrapper.cmd']) {
    assert.deepEqual(resolveCodexInvocation(executable,['fixture.js'],root),{command:executable,args:['fixture.js']});
  }
});

test('Pi subagent snapshots expose child messages once and keep tool identity', () => {
  const seen=new Map();
  const frame={toolCallId:'parent',partialResult:{details:{results:[{agent:'scout',messages:[
    {role:'assistant',content:[{type:'thinking',thinking:'inspect'},{type:'text',text:'reading'},{type:'toolCall',id:'read-1',name:'read',arguments:{path:'fixture'}}]},
    {role:'toolResult',toolCallId:'read-1',toolName:'read',content:[{type:'text',text:'result'}],isError:false}
  ]}]}}};
  const events=childEvents(frame,'subagent',seen);
  assert.deepEqual(events.map(event=>event.kind),['thinking','message','tool','tool']);
  assert.ok(events.every(event=>event.subagentDispatchId==='parent'));
  assert.equal(events[2].callId,events[3].callId);
  assert.deepEqual(childEvents(frame,'subagent',seen),[]);
  assert.ok(subagentMeta('subagent',{tasks:[{agent:'scout',task:'inspect'},{agent:'reviewer',task:'review'}]}));
});

test('request usage totals replace duplicates and retain unknown counters', () => {
  const usage = new TurnUsage();
  const first = {kind:'usage',inputTokens:10,outputTokens:2,cachedInputTokens:3,cacheCreationInputTokens:0};
  usage.update('one',first);
  assert.equal(usage.update('one',first).inputTokens,10);
  const total=usage.update('two',{kind:'usage',inputTokens:20,outputTokens:4,cachedInputTokens:5});
  assert.equal(total.inputTokens,30);
  assert.equal(total.outputTokens,6);
  assert.equal(total.cachedInputTokens,8);
  assert.equal(total.cacheCreationInputTokens,undefined);
  assert.equal(total.contextUsed,undefined);
});

test('OpenCode totals stay separate by parent/child session and repeated part', () => {
  const stream=new OpenCodePartStream();
  for (const [session,id,input,total] of [['main','one',10,10],['child','child-one',99,99],['main','two',20,30],['main','two',20,30]]) {
    const events=stream.update({id,sessionID:session,type:'step-finish',tokens:{input,output:1,cache:{read:0,write:0}}},{});
    assert.equal(events.at(-1).usageScope,'turn');
    assert.equal(events.at(-1).inputTokens,total);
  }
});

test('images reach native Anthropic/ACP blocks and text-only CLI file references', t => {
  const cwd=mkdtempSync(join(tmpdir(),'nautilo-prompt-images-'));
  t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  writeFileSync(join(cwd,'test.JPG'),Buffer.from([1,2,3]));
  const request={cwd,prompt:'inspect',localImagePaths:['test.JPG']};
  const claude=imagePromptBlocks(request,true), acp=imagePromptBlocks(request);
  assert.deepEqual(claude[1],{type:'image',source:{type:'base64',media_type:'image/jpeg',data:'AQID'}});
  assert.deepEqual(acp[1],{type:'image',mimeType:'image/jpeg',data:'AQID'});
  assert.ok(promptWithImageFiles(request).includes(JSON.stringify(join(cwd,'test.JPG'))));
  assert.throws(()=>imagePromptBlocks({...request,localImagePaths:['missing.png']}));
  writeFileSync(join(cwd,'schema.json'),JSON.stringify({type:'object',properties:{answer:{type:'string'}}}));
  const params=buildCodexTurnStartParams({...request,instance:{providerOptions:{}},outputSchemaPath:'schema.json'},'thread');
  assert.equal(params.outputSchema.properties.answer.type,'string');
});

test('custom argument prefixes retain chosen parameters and unrelated config', () => {
  const args=mergeCliArgs(['wrapper.js','--model','old','--settings','native.json','--config','native=true'],
    ['--model','chosen','--effort','max','--settings','{}','--config','model_reasoning_effort="max"','--config','service_tier="fast"']);
  assert.equal(args[0],'wrapper.js');
  assert.equal(args.filter(arg=>arg==='--model').length,1);
  assert.equal(args[args.indexOf('--model')+1],'chosen');
  assert.ok(args.includes('native.json'));
  assert.ok(args.includes('native=true'));
  assert.ok(args.includes('model_reasoning_effort="max"'));
  assert.ok(args.includes('service_tier="fast"'));
});

test('final JSON without newline is normalized before exit', async () => {
  const process={events:(async function*(){yield {kind:'stdout',text:'{"text":"last answer"}'};yield {kind:'exit',exitCode:0};})()};
  const events=[];
  for await (const event of streamEvents(process,true,value=>[{kind:'message',phase:'completed',text:value.text}])) events.push(event);
  assert.deepEqual(events.map(event=>event.kind),['message','exit']);
  assert.equal(events[0].text,'last answer');
});

test('broken native skill links do not block inheriting valid resources', t => {
  const root=mkdtempSync(join(tmpdir(),'nautilo-resource-links-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'native','skills'),{recursive:true});
  writeFileSync(join(root,'native','skills','SKILL.md'),'valid');
  symlinkSync(join(root,'missing'),join(root,'native','skills','broken'),process.platform==='win32'?'junction':'dir');
  inheritNativeResources(join(root,'native'),join(root,'target'),['skills']);
  assert.equal(readFileSync(join(root,'target','skills','SKILL.md'),'utf8'),'valid');
});

test('ACP uses legacy model selection and does not swallow unavailable reasoning settings', async () => {
  const calls=[];
  const rpc={request:async(method,params)=>{calls.push({method,params});return {};}};
  const response={models:{availableModels:[{modelId:'chosen'}]}};
  const request={instance:{providerOptions:{}},model:'chosen'};
  await applyConfig(rpc,'session',response,request);
  assert.equal(calls[0].method,'session/set_model');
  await assert.rejects(applyConfig(rpc,'session',response,{...request,reasoningEffort:'max'}),/reasoning effort/);
  await applyConfig(rpc,'session',response,{...request,reasoningEffort:'max',env:{NAUTILO_BRIDGE_EFFORT:'max'}});
});

test('OpenCode keeps reasoning and multiple text parts in their original stream identity', () => {
  const stream = new OpenCodePartStream();
  assert.deepEqual(stream.delta({ partID: 'reason', field: 'text', delta: 'think' }, {}), []);
  const reasoning = stream.update({ id: 'reason', messageID: 'msg', type: 'reasoning' }, {});
  assert.equal(reasoning[0].kind, 'thinking');
  assert.equal(reasoning[0].messageId, 'reason');
  assert.equal(reasoning[0].text, 'think');
  for (const id of ['first', 'second']) {
    stream.update({ id, messageID: 'msg', type: 'text' }, {});
    const delta = stream.delta({ partID: id, field: 'text', delta: id }, {});
    const completed = stream.update({ id, messageID: 'msg', type: 'text', text: id, time: { end: 1 } }, {});
    assert.equal(delta[0].messageId, id);
    assert.equal(completed.find(event => event.kind === 'message').messageId, id);
  }
  assert.deepEqual(stream.delta({ partID: 'first', field: 'metadata', delta: 'x' }, {}), []);
});

test('OpenCode child activity cannot overwrite the main resume identity or billing/status', () => {
  const events = parseOpenCodeEvent({ type: 'text', sessionID: 'child', part: { id: 'part', text: 'child reply' } });
  const mapped = withOpenCodeSubagentDispatch([
    ...events, { kind: 'usage', inputTokens: 99 }, { kind: 'status', phase: 'turn_completed' },
    { kind: 'error', message: 'child failed' }, { kind: 'exit', exitCode: 0 }
  ], 'task-call');
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].kind, 'message');
  assert.equal(mapped[0].subagentDispatchId, 'task-call');
});

test('OpenCode preserves cache creation usage separately from context', () => {
  const usage = parseOpenCodeEvent({ type: 'step_finish', part: { tokens: { input: 10, output: 7, cache: { read: 20, write: 5 } } } }).find(e => e.kind === 'usage');
  assert.equal(usage.cacheCreationInputTokens, 5);
  assert.equal(usage.usageScope, 'context');
  assert.equal(usage.inputTokensIncludesCache, false);
  assert.equal(usage.contextUsed, 35);
});

test('OpenCode image parts keep MIME and escape local paths; missing attachments fail', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nautilo-image-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'photo # 中文.JPG');
  writeFileSync(path, 'fixture');
  const part = openCodeImagePart(path, directory);
  assert.equal(part.mime, 'image/jpeg');
  assert.equal(part.url, pathToFileURL(path).href);
  assert.throws(() => openCodeImagePart('missing.png', directory));
});

test('Trae connection overlay preserves native agents, providers, models and lakeview options', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nautilo-trae-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const native = { agents: { trae_agent: { model: 'original', tools: ['bash'] }, reviewer: { model: 'original' } },
    models: { original: { model: 'original', max_tokens: 4000 } }, model_providers: { original: { provider: 'openai' } },
    lakeview: { model: 'original', custom: true }, mcp_servers: { existing: { command: 'fixture' } } };
  writeFileSync(join(directory, 'trae_config.json'), JSON.stringify(native));
  const result = buildOpenSourceConfiguration({ cwd: directory, model: 'chosen', env: {} }, 'http://127.0.0.1:1234');
  assert.deepEqual(result.agents.reviewer, native.agents.reviewer);
  assert.deepEqual(result.agents.trae_agent.tools, ['bash']);
  assert.deepEqual(result.models.original, native.models.original);
  assert.equal(result.models.selected.max_tokens, 4000);
  assert.equal(result.models.selected.model, 'chosen');
  assert.deepEqual(result.model_providers.original, native.model_providers.original);
  assert.equal(result.lakeview.custom, true);
  assert.deepEqual(result.mcp_servers, native.mcp_servers);
});
