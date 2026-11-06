import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const require=createRequire(import.meta.url);let JSDOM;
try{({JSDOM}=require(process.env.NAUTILO_JSDOM_PATH??'jsdom'));}catch{}
test('PTC UI exposes actual nested tools and keeps description, expansion and results across updates',{skip:!JSDOM},async()=>{
  const desktop=fileURLToPath(new URL('..',import.meta.url));
  const{build}=createRequire(require.resolve('vite/package.json'))('esbuild');
  const bundle=await build({stdin:{resolveDir:desktop,loader:'tsx',contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';
    import{CodeExecutionCard}from'./src/renderer/src/features/timeline/CodeExecutionCard';
    const root=createRoot(document.getElementById('root'));window.qa={render:data=>flushSync(()=>root.render(<CodeExecutionCard data={data} locale='zh-CN'/>)),close:()=>flushSync(()=>root.unmount())};
  `},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,nodePaths:[join(desktop,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},loader:{'.css':'empty'}});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;
  const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
  const data={kind:'tool_activity',toolName:'run_code',status:'running',input:JSON.stringify({description:'Render final check frame',code:'await tools.pwsh({command:"render"})'}),codeExecution:{calls:[
    {callId:'cancel',parentCallId:'root',name:'job_kill',input:{job_id:'pwsh-1'},output:'requested cancellation of job pwsh-1',status:'done'},
    {callId:'shell',parentCallId:'root',name:'pwsh',input:{description:'Check Python and Pillow availability',command:'python --version'},status:'running'}]}};
  try{
    w.eval(bundle.outputFiles[0].text);w.qa.render(data);
    const labels=()=>[...w.document.querySelectorAll('.process-disclosure-row')];
    assert.equal(labels().length,3);assert.ok(labels()[0].textContent.includes('Render final check frame'));
    assert.ok(labels()[1].textContent.includes('取消后台任务'));assert.ok(labels()[1].textContent.includes('已请求取消'));
    assert.ok(labels()[2].textContent.includes('运行命令'));assert.ok(labels()[2].textContent.includes('Check Python and Pillow availability'));
    labels()[0].click();labels()[2].click();await tick();
    const expandedShell=labels()[2];assert.equal(expandedShell.getAttribute('aria-expanded'),'true');
    assert.ok(w.document.body.textContent.includes('python --version'));
    const next=structuredClone(data);next.status='done';next.codeExecution.calls[1].status='done';next.codeExecution.calls[1].output='Python 3.13.14';w.qa.render(next);
    assert.equal(labels()[2],expandedShell);assert.equal(expandedShell.getAttribute('aria-expanded'),'true');
    assert.ok(w.document.body.textContent.includes('Python 3.13.14'));assert.ok(labels()[0].textContent.includes('Render final check frame'));
    assert.ok(w.document.querySelector('pre code').textContent.includes('await tools.pwsh'));
  }finally{w.qa?.close();w.close();}
});
