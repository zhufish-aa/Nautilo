import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
let JSDOM;
try {({JSDOM}=require(process.env.NAUTILO_JSDOM_PATH??'jsdom'));} catch {}

test('terminal resize, maximize and theme preserve the native process and restore saved height', {skip:!JSDOM}, async()=>{
  const desktop=fileURLToPath(new URL('..',import.meta.url));
  const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
  const bundle=await build({stdin:{resolveDir:desktop,loader:'tsx',contents:`
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{I18nProvider}from'./src/renderer/src/lib/i18n';
    import{WorkspaceDrawer}from'./src/renderer/src/features/sessions/WorkspaceDrawer';
    import{NativeTerminal}from'./src/renderer/src/features/sessions/NativeTerminal';
    const root=createRoot(document.getElementById('root'));
    function Panel(){const[target,setTarget]=useState(null);return <WorkspaceDrawer open title='终端' placement='bottom' resizable storageKey='size' onClose={()=>window.qa.close()} headerActions={<div ref={setTarget}/>}> <NativeTerminal sessionId='s' kind='harness' toolbarTarget={target}/></WorkspaceDrawer>}
    window.qa={instances:[],calls:[],render(){flushSync(()=>root.render(<I18nProvider><Panel/></I18nProvider>));},hide(){flushSync(()=>root.render(null));},close(){flushSync(()=>root.unmount());}};
  `},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,nodePaths:[join(desktop,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},loader:{'.css':'empty'},plugins:[{name:'xterm-fixture',setup(b){
    b.onResolve({filter:/^@xterm\/(xterm|addon-fit)$/},args=>({path:args.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('addon-fit')?`export class FitAddon{activate(t){this.t=t}fit(){const t=this.t;const rows=Math.floor(window.terminalHeight/17);if(rows!==t.rows){t.rows=rows;t.resize?.({cols:t.cols,rows})}}}`:`export class Terminal{cols=90;rows=12;constructor(options){this.options=options;window.qa.instances.push(this)}loadAddon(a){a.activate(this)}open(){}focus(){}onData(){return{dispose(){}}}onResize(fn){this.resize=fn;return{dispose(){}}}attachCustomKeyEventHandler(){}write(data,done){done?.()}reset(){}dispose(){this.disposed=true}}`}));
  }}]});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
  w.terminalHeight=200;const observers=[];
  w.ResizeObserver=class{constructor(fn){this.fn=fn;observers.push(this)}observe(){}disconnect(){}};
  w.HTMLElement.prototype.setPointerCapture=()=>{};w.HTMLElement.prototype.releasePointerCapture=()=>{};
  Object.defineProperty(w.HTMLElement.prototype,'clientHeight',{get(){return this.classList.contains('native-terminal-surface')?w.terminalHeight:800}});
  Object.defineProperty(w.HTMLElement.prototype,'clientWidth',{get(){return 900}});
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
  w.agenthub={core:{request:async({method,input})=>{w.qa.calls.push({method,input});if(method==='terminal.native')return{id:'pty-1'};if(method==='terminal.read')return{data:'',cursor:0,exited:false};return{};}}};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
  const button=label=>w.document.querySelector('button[aria-label="'+label+'"]');
  const pointer=(node,type,y)=>{const event=new w.MouseEvent(type,{bubbles:true,button:0,clientY:y});Object.defineProperty(event,'pointerId',{value:1});node.dispatchEvent(event);};
  try{
    w.eval(bundle.outputFiles[0].text);w.qa.render();await tick();
    const panel=()=>w.document.querySelector('aside');let handle=w.document.querySelector('[role="separator"]');
    assert.equal(panel().style.height,'320px');assert.equal(w.qa.instances.length,1);
    pointer(handle,'pointerdown',500);pointer(handle,'pointermove',350);pointer(handle,'pointerup',350);await tick();
    assert.equal(panel().style.height,'470px');assert.equal(w.localStorage.getItem('size'),'470');assert.equal(w.document.body.style.userSelect,'');
    handle.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));await tick();assert.equal(panel().style.height,'502px');
    w.terminalHeight=370;observers.forEach(o=>o.fn());await tick();
    assert.ok(w.qa.calls.some(c=>c.method==='terminal.resize'&&c.input.rows===21));
    button('最大化终端').click();await tick();assert.ok(panel().classList.contains('is-maximized'));
    button('还原终端').click();await tick();assert.equal(panel().style.height,'502px');
    button('切换终端配色').click();await tick();assert.equal(w.qa.instances[0].options.theme.background,'#ffffff');
    assert.equal(w.qa.instances.length,1);assert.equal(w.qa.calls.filter(c=>c.method==='terminal.native').length,1);assert.equal(w.qa.calls.filter(c=>c.method==='terminal.close').length,0);
    assert.equal(w.document.querySelectorAll('header').length,1,'native controls share the drawer toolbar');
    w.qa.hide();await tick();assert.equal(w.qa.calls.filter(c=>c.method==='terminal.close').length,0);
    w.qa.render();await tick();assert.equal(panel().style.height,'502px');assert.equal(w.document.querySelector('.native-terminal').dataset.appearance,'light');
  }finally{w.qa?.close();w.close();}
});
