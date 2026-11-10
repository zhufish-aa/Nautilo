import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
let JSDOM;
try {({JSDOM}=require(process.env.NAUTILO_JSDOM_PATH??'jsdom'));} catch {}
const until=async(predicate)=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'terminal workspace did not settle');await new Promise(resolve=>setTimeout(resolve,15));}};
let bundlePromise;
async function fixture({saved,terminals=[],nativeAvailable=false}={}) {
  const desktop=fileURLToPath(new URL('..',import.meta.url));
  bundlePromise??=createRequire(require.resolve('vite/package.json'))('esbuild').build({stdin:{resolveDir:desktop,loader:'tsx',contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{I18nProvider}from'./src/renderer/src/lib/i18n';import{TerminalDrawer}from'./src/renderer/src/features/sessions/TerminalWorkspace';
    const root=createRoot(document.getElementById('root'));let open=true;let sessionId='s';
    window.qa={calls:[],instances:[],errors:[],render(){flushSync(()=>root.render(<I18nProvider><TerminalDrawer open={open} sessionId={sessionId} onClose={()=>window.qa.hide()}/></I18nProvider>));},hide(){open=false;this.render()},show(){open=true;this.render()},session(id){sessionId=id;this.render()},reset(){flushSync(()=>root.render(null));this.render()},close(){flushSync(()=>root.unmount())}};
  `},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,nodePaths:[join(desktop,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},loader:{'.css':'empty'},plugins:[{name:'terminal-fixture',setup(b){
    b.onResolve({filter:/stores\/sessions$/},()=>({path:'sessions',namespace:'fixture'}));
    b.onResolve({filter:/stores\/toast$/},()=>({path:'toast',namespace:'fixture'}));
    b.onResolve({filter:/^@xterm\/(xterm|addon-fit)$/},args=>({path:args.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='sessions'?`export const SESSION_EMPTY={lines:[]};export const useSessionsStore=fn=>fn({rawLog:{}});`:args.path==='toast'?`export const toast={error:e=>window.qa.errors.push(e)};`:args.path.endsWith('addon-fit')?`export class FitAddon{activate(t){this.t=t}fit(){}}`:`export class Terminal{cols=90;rows=12;constructor(options){this.options=options;window.qa.instances.push(this)}loadAddon(a){a.activate(this)}open(node){this.node=node}focus(){this.node.tabIndex=-1;this.node.focus()}onData(fn){this.input=fn;return{dispose(){}}}onResize(){return{dispose(){}}}attachCustomKeyEventHandler(){}write(data,done){this.output=(this.output??'')+new TextDecoder().decode(data);done?.()}reset(){}dispose(){this.disposed=true}}`}));
  }}]});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
  w.ResizeObserver=class{observe(){}disconnect(){}};
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  w.TextDecoder=TextDecoder;w.HTMLElement.prototype.scrollIntoView=()=>{};
  Object.defineProperty(w.HTMLElement.prototype,'clientHeight',{get(){return 800}});Object.defineProperty(w.HTMLElement.prototype,'clientWidth',{get(){return 900}});
  if(saved)w.localStorage.setItem('nautilo.terminal.tabs.v1.s',JSON.stringify({version:1,active:'default',nextOrdinal:2,nativeOpened:false,...saved}));
  const entries=new Map(terminals.map(entry=>[entry.id,{sessionId:'s',...entry}]));let ordinal=0,hold=false;const pending=[];
  const spawn=input=>{const old=[...entries.values()].find(entry=>entry.sessionId===input.sessionId&&entry.tabId===(input.tabId??'native'));if(old&&(!old.exited||input.restoreOnly))return old;if(input.restoreOnly)throw new Error('Terminal tab is no longer available');const entry={id:'pty-'+(++ordinal),cwd:'D:\\fixture',pid:100+ordinal,kind:input.tabId?'shell':'harness',tabId:input.tabId??'native',sessionId:input.sessionId};entries.set(entry.id,entry);return entry};
  w.agenthub={core:{request:async({method,input})=>{
    w.qa.calls.push({method,input});
    if(method==='agent.runtimeCapabilities')return{interactions:{nativeTerminal:nativeAvailable}};
    if(method==='terminal.list')return{items:[...entries.values()].filter(entry=>entry.sessionId===input.sessionId)};
    if(method==='terminal.status'){const native=[...entries.values()].find(entry=>entry.sessionId===input.sessionId&&entry.kind==='harness'&&!entry.exited);return{nativeActive:!!native,terminalId:native?.id};}
    if(method==='terminal.open'||method==='terminal.native'){if(hold){hold=false;return await new Promise(resolve=>pending.push(()=>resolve(spawn(input))));}return spawn(input);}
    if(method==='terminal.read'){const entry=entries.get(input.terminalId);if(!entry)throw new Error('Terminal closed');const data=input.cursor===0?(entry.output??''):'';return{data:w.btoa(data),cursor:input.cursor+data.length,exited:!!entry.exited,exitCode:entry.exitCode};}
    if(method==='terminal.stop'){entries.get(input.terminalId).exited=true;return{ok:true};}
    if(method==='terminal.close'){for(const [id,entry]of entries)if(input.terminalId?id===input.terminalId:entry.sessionId===input.sessionId&&entry.tabId===input.tabId)entries.delete(id);return{ok:true};}
    return{ok:true};
  }}};
  w.eval((await bundlePromise).outputFiles[0].text);w.qa.render();
  return{w,entries,hold(){hold=true},release(){pending.shift()?.()},button(label){return w.document.querySelector(`button[aria-label="${label}"]`)},tab(id){return w.document.querySelector(`[role="tab"][data-tab-id="${id}"]`)},calls(method){return w.qa.calls.filter(call=>call.method===method)},async close(){w.qa.close();w.close()}};
}

test('shell tabs switch without remounting, keep running when hidden and close independently',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    await until(()=>f.calls('terminal.open').length===1&&w.qa.instances.length===1);
    f.button('新建终端').click();await until(()=>f.calls('terminal.open').length===2&&f.entries.size===2);
    const second=[...f.entries.values()].find(entry=>entry.tabId!=='default');
    f.tab('default').click();await until(()=>f.tab('default').getAttribute('aria-selected')==='true');
    assert.equal(w.qa.instances.length,2);assert.equal(f.calls('terminal.open').length,2);
    assert.equal(w.document.querySelectorAll('button[aria-label="结束终端"]').length,1,'only the active tab owns toolbar controls');
    w.qa.hide();assert.equal(w.document.querySelector('aside').hidden,true);assert.ok(w.qa.instances.every(instance=>!instance.disposed));
    w.qa.show();await until(()=>!w.document.querySelector('aside').hidden);assert.equal(f.calls('terminal.open').length,2);
    f.button('结束终端').click();await until(()=>w.document.body.textContent.includes('已退出'));
    assert.equal(f.calls('terminal.stop').length,1);assert.equal(f.calls('terminal.close').length,0);assert.equal(f.entries.get(second.id).exited,undefined);
    f.tab('default').dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));await until(()=>w.document.querySelector('input[aria-label="终端名称"]'));
    const input=w.document.querySelector('input[aria-label="终端名称"]');const setter=Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set;setter.call(input,'开发服务');input.dispatchEvent(new w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,20));input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await until(()=>f.button('关闭开发服务'));assert.match(w.localStorage.getItem('nautilo.terminal.tabs.v1.s'),/开发服务/);
    f.button('关闭开发服务').click();await until(()=>!f.tab('default'));assert.equal(f.entries.size,1);assert.equal(f.entries.get(second.id).exited,undefined);
    await until(()=>w.qa.instances[0].disposed);assert.equal(w.qa.instances[1].disposed,undefined);
    assert.equal(w.qa.errors.length,0);
  }finally{await f.close();}
});

test('restored exited and missing tabs never start new processes until reconnect is requested',{skip:!JSDOM},async()=>{
  const f=await fixture({saved:{tabs:[{id:'default',ordinal:1},{id:'missing',ordinal:2}],nextOrdinal:3},terminals:[{id:'old-pty',tabId:'default',kind:'shell',cwd:'D:\\fixture',exited:true,exitCode:0,output:'retained output'}]});const{w}=f;
  try{
    await until(()=>w.document.body.textContent.includes('已退出'));assert.equal(f.calls('terminal.open').length,0);assert.equal(w.qa.instances[0].output,'retained output');
    f.tab('missing').click();await until(()=>w.document.body.textContent.includes('该终端已离线'));
    assert.equal(f.calls('terminal.open').length,1);assert.equal(f.calls('terminal.open')[0].input.restoreOnly,true);assert.equal(f.entries.size,1);
    f.button('重新连接终端').click();await until(()=>f.entries.size===2);assert.equal(f.calls('terminal.open')[1].input.restoreOnly,false);
    w.qa.session('other');await until(()=>f.calls('terminal.list').some(call=>call.input.sessionId==='other'));
    w.qa.session('s');await until(()=>f.tab('missing')&&f.calls('terminal.read').some(call=>call.input.terminalId!=='old-pty'));
    assert.equal(f.calls('terminal.open').filter(call=>call.input.sessionId==='s').length,2,'returning to a session attaches retained terminals');
  }finally{await f.close();}
});

test('closing while a tab opens cleans up the late process and never restores the closed tab',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    await until(()=>f.entries.size===1);f.hold();f.button('新建终端').click();await until(()=>f.calls('terminal.open').length===2);
    f.button('关闭终端 2').click();await until(()=>w.document.querySelectorAll('.terminal-tab-entry').length===1);
    f.release();await until(()=>f.calls('terminal.close').some(call=>call.input.terminalId));
    assert.equal(f.entries.size,1);assert.equal(f.calls('terminal.close').filter(call=>call.input.tabId).length,1);
    w.qa.reset();await until(()=>w.document.querySelectorAll('.terminal-tab-entry').length===1);assert.equal(f.calls('terminal.open').length,2);
  }finally{await f.close();}
});

test('native CLI is one retained terminal beside independent shells',{skip:!JSDOM},async()=>{
  const f=await fixture({nativeAvailable:true});
  try{
    await until(()=>f.tab('native')&&f.entries.size===1);f.tab('native').click();await until(()=>f.calls('terminal.native').length===1&&f.entries.size===2);
    f.tab('default').click();await until(()=>f.tab('default').getAttribute('aria-selected')==='true');
    f.tab('native').click();await until(()=>f.tab('native').getAttribute('aria-selected')==='true');
    assert.equal(f.calls('terminal.native').length,1);assert.equal(f.calls('terminal.open').length,1);assert.equal(f.w.document.querySelectorAll('button[aria-label="结束终端"]').length,1);
  }finally{await f.close();}
});

test('keyboard navigation retains tab focus and can create, rename and close a terminal',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    await until(()=>f.entries.size===1);
    const key=(node,value,modifiers={})=>node.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...modifiers}));
    key(f.tab('default'),'T',{ctrlKey:true,shiftKey:true});await until(()=>f.entries.size===2);
    const second=[...f.entries.values()].find(entry=>entry.tabId!=='default');
    f.tab('default').click();f.tab('default').focus();key(f.tab('default'),'ArrowRight');
    await until(()=>f.tab(second.tabId).getAttribute('aria-selected')==='true');
    assert.equal(w.document.activeElement?.dataset.tabId,second.tabId,'terminal activation must preserve keyboard focus in the tablist');
    key(f.tab(second.tabId),'F2');await until(()=>w.document.querySelector('input[aria-label="终端名称"]'));
    key(w.document.activeElement,'Escape');await until(()=>!w.document.querySelector('input[aria-label="终端名称"]'));
    key(f.tab(second.tabId),'W',{ctrlKey:true,shiftKey:true});await until(()=>f.entries.size===1);
    assert.equal(f.entries.values().next().value.tabId,'default');
  }finally{await f.close();}
});

test('unvisited sessions may open their first shell while closing every tab persists an empty workspace',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    await until(()=>f.entries.size===1);w.qa.hide();w.qa.session('unused');
    await until(()=>w.localStorage.getItem('nautilo.terminal.tabs.v1.unused'));assert.equal(f.entries.size,1);
    w.qa.session('s');w.qa.session('unused');w.qa.show();await until(()=>[...f.entries.values()].some(entry=>entry.sessionId==='unused'));
    f.button('关闭终端 1').click();await until(()=>w.document.querySelectorAll('.terminal-tab-entry').length===0);
    const before=f.calls('terminal.open').length;w.qa.reset();await until(()=>f.tab('logs').getAttribute('aria-selected')==='true');
    assert.equal(f.calls('terminal.open').length,before);assert.equal(w.document.querySelectorAll('.terminal-tab-entry').length,0);
  }finally{await f.close();}
});
