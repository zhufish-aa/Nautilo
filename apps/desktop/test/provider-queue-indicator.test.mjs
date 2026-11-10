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
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>name==='react'?React:name==='react/jsx-runtime'?jsx:name==='lucide-react'?{Loader2:()=>null}:{useI18n:()=>({locale})}});
const render=(phase,status='running')=>renderToStaticMarkup(React.createElement(exports.RunActivityIndicator,{lifecycle:{status,startedAt:'2026-01-01'},events:[{id:'q',timestamp:'2026-01-02',data:{kind:'activity',phase}}]}));
test('shared provider queue is visible and does not pretend to be approval or reasoning',()=>{
 const html=render('provider_queued');assert(html.includes('Agent busy · queued'));assert(html.includes('role="status"'));assert(!html.includes('approval'));assert(!html.includes('Thinking'));assert(html.includes('aria-hidden="true"'));
 locale='zh-CN';assert(render('provider_queued').includes('Agent 正忙，排队中'));locale='en';
});
test('startup stays visible before the CLI returns content and terminal states clear the indicator',()=>{
 assert(render('queued').includes('Request sent'));assert(render('starting').includes('Waiting for agent'));assert.equal(render('provider_queued','cancelled'),'');assert.equal(render('provider_queued','failed'),'');assert(render('thinking').includes('Thinking'));
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
 for(const event of [progress('tool_activity',{status:'done',toolName:'Read'}),progress('command',{status:'done'}),progress('reasoning',{streaming:false})])assert(renderEvents([event]).includes('Thinking'));
});
test('live rows including grouped tools do not duplicate the indicator, and replies keep it hidden',()=>{
 for(const event of [progress('tool_activity',{status:'running'}),progress('reasoning',{streaming:true}),progress('message',{sender:'agent',streaming:true}),progress('message',{sender:'agent',streaming:false})])assert.equal(renderEvents([event]),'');
 const group=progress('tool_group',{items:[progress('command',{status:'running'})]});assert.equal(renderEvents([group]),'');
 assert(renderEvents([group],{status:'running',reason:'cancelling'}).includes('Stopping'));
 assert.equal(renderEvents([],{status:'completed'}),'');
});
