import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { create } from 'zustand';
import { helperModules } from './helpers/orchestration-runtime-harness.mjs';
const require=createRequire(import.meta.url);
let JSDOM;try{({JSDOM}=require(process.env.NAUTILO_JSDOM_PATH??'jsdom'));}catch{}

test('closed artifact drawer performs no file aggregation; opening is current and preserves selection/tab', {skip:!JSDOM&&'Set NAUTILO_JSDOM_PATH to installed jsdom'}, async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const {createRoot}=require('react-dom/client');const {act}=React;
 const rows=['a','b'].map((path,i)=>({id:String(i),sessionId:'s',runId:'r',sequence:i,data:{kind:'file_change',files:[{path,changeType:'modified',additions:1,deletions:1,diff:'@@ -1 +1 @@\n-old\n+new'}]}}));
 const sessions=create(()=>({sessions:[{id:'s',projectId:'p'}],events:{s:rows},artifacts:{s:[{id:'contract',kind:'api_contract',name:'contract',content:'saved contract'}]}}));
 const teams=create(()=>({teams:[]})),agents=create(()=>({instances:[]})),projects=create(()=>({projects:[{id:'p',rootPath:'/fixture'}]}));
 let aggregations=0;
 const empty=()=>null;const dummy=new Proxy({}, {get:()=>empty});
 const t=(key)=>key;
 const modules={react:React,'react/jsx-runtime':require('react/jsx-runtime'),
 '../../lib/i18n':{useI18n:()=>({t,locale:'en'})},
 '../../lib/changed-files':{collectChangedFiles:(events)=>{aggregations++;return helperModules['./changed-files'].collectChangedFiles(events);}},
 '../../stores/sessions':{useSessionsStore:sessions,SESSION_EMPTY:{events:[],artifacts:[],lines:[]}},
 '../../stores/teams':{useTeamsStore:teams},'../../stores/agents':{useAgentsStore:agents},'../../stores/projects':{useProjectsStore:projects},
 '../../lib/utils':{cn:(...parts)=>parts.filter(Boolean).join(' ')},
 '../../lib/highlight':{highlightDiffLine:(line)=>line},
 '../../lib/use-progressive-rows':{useProgressiveRows:(length)=>({limit:length,showAll(){},sentinelRef:null})},
 './WorkspaceDrawer':{WorkspaceDrawer:({children})=>React.createElement('section',null,children)},
 '../../components/ui/Tabs':{TabBar:({items,onValueChange,value})=>React.createElement('nav',null,items.map(item=>React.createElement('button',{key:item.value,'data-tab':item.value,'aria-selected':value===item.value,onClick:()=>onValueChange(item.value)},item.label)))},
 '../timeline/MarkdownContent':{MarkdownContent:({content})=>React.createElement('div',null,content)},
 './SessionListPanel':{sessionTargetName:()=>''}};
 const exports={};const source=readFileSync(new URL('../src/renderer/src/features/sessions/Drawers.tsx',import.meta.url),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>modules[name]??dummy,window:dom.window,console});
 const root=createRoot(document.getElementById('root'));const render=async(open)=>act(async()=>root.render(React.createElement(exports.ArtifactsDrawer,{open,onClose(){},sessionId:'s'})));
 try{
  await render(false);assert.equal(aggregations,0);
  for(let i=0;i<20;i++)await act(async()=>sessions.setState(state=>({events:{...state.events,s:[...rows,{id:'stream',sessionId:'s',data:{kind:'message',text:String(i)}}]}})));
  assert.equal(aggregations,0);
  await render(true);assert.equal(aggregations,1);
  await act(async()=>document.querySelector('button[title="b"]').click());
  await render(false);const before=aggregations;
  await act(async()=>sessions.setState(state=>({events:{...state.events,s:[...state.events.s,{id:'text',sessionId:'s',data:{kind:'message',text:'latest'}}]}})));
  assert.equal(aggregations,before);
  await render(true);assert.equal(document.querySelector('button[title="b"]').getAttribute('aria-current'),'true');
  await act(async()=>document.querySelector('[data-tab="api_contract"]').click());
  await render(false);await render(true);
  assert.equal(document.querySelector('[data-tab="api_contract"]').getAttribute('aria-selected'),'true');
  assert(document.body.textContent.includes('saved contract'));
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.HTMLElement;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
