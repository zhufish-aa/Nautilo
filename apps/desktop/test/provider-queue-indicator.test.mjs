import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
const source=readFileSync(new URL('../src/renderer/src/features/sessions/RunActivityIndicator.tsx',import.meta.url),'utf8');
const exports={};let locale='en';
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>name==='react'?React:name==='react/jsx-runtime'?jsx:name==='lucide-react'?{Activity:()=>null}:{useI18n:()=>({locale})}});
const render=(phase,status='running')=>renderToStaticMarkup(React.createElement(exports.RunActivityIndicator,{lifecycle:{status,startedAt:'2026-01-01'},events:[{id:'q',timestamp:'2026-01-02',data:{kind:'activity',phase}}]}));
test('shared provider queue is visible and does not pretend to be approval or reasoning',()=>{
 const html=render('provider_queued');assert(html.includes('Agent busy · queued'));assert(html.includes('role="status"'));assert(!html.includes('approval'));assert(!html.includes('Thinking'));assert(html.includes('aria-hidden="true"'));
 locale='zh-CN';assert(render('provider_queued').includes('Agent 正忙，排队中'));locale='en';
});
test('startup stays visible before the CLI returns content and terminal states clear the indicator',()=>{
 const startup=render('starting');
 assert(render('queued').includes('Request sent'));assert.match(startup,/>Waiting for agent</);assert.doesNotMatch(startup,/conversation-wait-time|0s/);
 assert.equal(render('provider_queued','cancelled'),'');assert.equal(render('provider_queued','failed'),'');assert(render('thinking').includes('Thinking'));
});

const renderEvents=(events,lifecycle={status:'running',startedAt:'2026-01-01'})=>renderToStaticMarkup(React.createElement(exports.RunActivityIndicator,{lifecycle,events}));
const progress=(kind,extra={})=>({id:'step',timestamp:'2026-01-02',data:{kind,...extra}});
test('Claude waiting for its first reasoning/text event has a thinking indicator',()=>{
 locale='zh-CN';
 const html=renderEvents([]);
 assert(html.includes('正在思考'));assert(html.includes('role="status"'));
 const old=progress('reasoning',{streaming:false});old.timestamp='2025-12-01';
 assert(renderEvents([old]).includes('正在思考'));
 locale='en';
});
test('completed tool and reasoning rows do not hide the next model wait',()=>{
 for(const event of [progress('tool_activity',{status:'done',toolName:'Read'}),progress('command',{status:'done'}),progress('reasoning',{streaming:false})]){
  const html=renderEvents([event]);
  assert.match(html,/>Thinking</);
  assert.match(html,/conversation-wait-orbit/);
  assert.doesNotMatch(html,/data-activity-mark/);
 }
});
test('approval wait keeps its label visible without running effects',()=>{
 const html=renderEvents([],{status:'waiting_approval'});
 assert.match(html,/Waiting for your approval/);
 assert.doesNotMatch(html,/conversation-wait-orbit|conversation-wait-sheen/);
});
test('live tool rows and replies do not duplicate the indicator',()=>{
 for(const event of [progress('tool_activity',{status:'running'}),progress('reasoning',{streaming:true}),progress('message',{sender:'agent',streaming:true}),progress('message',{sender:'agent',streaming:false})])assert.match(renderEvents([event]),/hidden="" aria-hidden="true"/);
 assert.match(renderEvents([progress('command',{status:'running'})]),/hidden="" aria-hidden="true"/);
 assert(renderEvents([progress('command',{status:'running'})],{status:'running',reason:'cancelling'}).includes('Stopping'));
 assert.equal(renderEvents([],{status:'completed'}),'');
});
