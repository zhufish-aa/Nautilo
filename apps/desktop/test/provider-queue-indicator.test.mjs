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
test('ordinary brief startup stays quiet and terminal queue state does not remain visible',()=>{
 assert.equal(render('queued'),'');assert.equal(render('starting'),'');assert.equal(render('provider_queued','cancelled'),'');assert.equal(render('provider_queued','failed'),'');assert(render('thinking').includes('Thinking'));
});
