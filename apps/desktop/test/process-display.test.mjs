import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { createHarness, delta } from './helpers/orchestration-runtime-harness.mjs';
const source = await readFile(new URL('../src/renderer/src/lib/process-display.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { reasoningPreview, toolOutput, toolCallTree, mergeCodeExecution, codeCallDescription } = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
test('reasoning shows one stable preview line without markup', () => {
  assert.equal(reasoningPreview('**First paragraph**\n\nSecond unfinished', true), 'First paragraph');
  assert.equal(reasoningPreview('First\n\nSecond paragraph\n\nThird unfinished', true), 'Second paragraph');
  assert.equal(reasoningPreview('**First**\ncontinued\n\nSecond', false), 'First');
});
test('background receipts retain job status and readable metadata', () => {
  const output = toolOutput(JSON.stringify({ kind: 'promoted', jobId: 'job-1', cwd: 'D:/work', timeoutMs: 240000, output: '' }), true);
  assert.equal(output.status, '已转为后台任务');
  assert.deepEqual(output.fields, [['任务','job-1'], ['目录','D:/work'], ['超时','240s']]);
});
test('PTC ancestry is nested and malformed cycles cannot hide calls', () => {
  const calls = [
    { callId: 'a', parentCallId: 'root', name: 'read', status: 'done' },
    { callId: 'b', parentCallId: 'a', name: 'write', status: 'running' },
    { callId: 'c', parentCallId: 'd', name: 'read', status: 'done' },
    { callId: 'd', parentCallId: 'c', name: 'read', status: 'done' },
  ];
  const tree = toolCallTree(calls);
  assert.equal(tree[0].children[0].call.callId, 'b');
  const ids=[];const visit=branch=>{ids.push(branch.call.callId);branch.children.forEach(visit)};tree.forEach(visit);
  assert.deepEqual(ids.sort(), ['a','b','c','d']);
});

test('DSH dispatch patches retain siblings, nesting and settled call status', () => {
  let state = {description:'Clean stuck Chrome jobs', calls:[]};
  const patch = call => ({partial:true,calls:[call]});
  state = mergeCodeExecution(state, patch({callId:'cancel',parentCallId:'root',name:'job_kill',input:{job_id:'pwsh-1'},status:'running'}));
  state = mergeCodeExecution(state, patch({callId:'shell',parentCallId:'root',name:'pwsh',input:{description:'Kill only my headless chrome instances',command:'fixture command'},status:'running'}));
  state = mergeCodeExecution(state, patch({callId:'cancel',name:'job_kill',status:'done',output:'requested cancellation of job pwsh-1'}));
  state = mergeCodeExecution(state, patch({callId:'cancel',name:'job_kill',status:'running'}));
  state = mergeCodeExecution(state, {partial:true,calls:[]});
  assert.equal(state.calls.length,2);
  assert.equal(state.description,'Clean stuck Chrome jobs');
  assert.equal(state.calls[0].status,'done');
  assert.deepEqual(codeCallDescription(state.calls[0],true),{title:'取消后台任务',summary:'pwsh-1 · 已请求取消'});
  assert.deepEqual(codeCallDescription(state.calls[1],true),{title:'运行命令',summary:'Kill only my headless chrome instances'});
  assert.deepEqual(codeCallDescription({callId:'read',name:'read',input:{path:'src/main.ts'},status:'done'},true),{title:'读取文件',summary:'src/main.ts'});
});

test('main timeline keeps one PTC batch with all dispatches after completion and replay', () => {
  const h=createHarness();
  const frame=(sequence,type,codeExecution,extra={})=>delta(sequence,'',{type,payload:{callId:'root',toolName:'run_code',codeExecution,...extra}});
  const events=[
    frame(1,'tool.started',{partial:true,description:'Render final check frame',calls:[]},{inputSummary:JSON.stringify({code:'await tools.read({path:"a"})'})}),
    frame(2,'tool.updated',{partial:true,calls:[{callId:'read',parentCallId:'root',name:'read',input:{path:'a'},status:'running'}]}),
    frame(3,'tool.updated',{partial:true,calls:[{callId:'shell',parentCallId:'root',name:'pwsh',input:{description:'Render four frames'},status:'done'}]}),
    frame(4,'tool.updated',{partial:true,calls:[{callId:'read',parentCallId:'root',name:'read',status:'done',output:'file content'}]}),
    frame(5,'tool.finished',{partial:true,calls:[]},{success:true,outputSummary:'done'})
  ];
  const rows=h.runtime.buildStandaloneTimeline([],events,[]).flatMap(row=>row.data.kind==='tool_group'?Array.from(row.data.items):[row]).filter(row=>row.data.kind==='tool_activity');
  assert.equal(rows.length,1);assert.equal(rows[0].data.status,'done');
  assert.equal(rows[0].data.codeExecution.description,'Render final check frame');
  assert.deepEqual(Array.from(rows[0].data.codeExecution.calls,call=>[call.callId,call.status]),[['read','done'],['shell','done']]);
  assert.equal(rows[0].data.codeExecution.calls[0].input.path,'a');
});
