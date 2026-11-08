import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const desktop=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(join(desktop,'package.json'));
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const bundles=new Map();
async function worker(kind){
  const entry=kind==='editor'?'monaco-editor/editor/editor.worker.js':`monaco-editor/language/${kind}/`+(kind==='typescript'?'ts':kind)+'.worker.js';
  if(!bundles.has(entry))bundles.set(entry,build({entryPoints:[require.resolve(entry)],bundle:true,platform:'browser',format:'iife',write:false,define:{'import.meta.url':'"file:///nautilo-worker-fixture.js"'},logLevel:'silent'}));
  const result=await bundles.get(entry);assert.equal(result.warnings.length,0,'worker fixture must bundle without hidden warnings');
  const prefix=`const {parentPort}=require('node:worker_threads');const listeners=new Map();globalThis.self=globalThis;globalThis.addEventListener=(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn)};globalThis.removeEventListener=(type,fn)=>listeners.get(type)?.delete(fn);globalThis.postMessage=value=>parentPort.postMessage(value);parentPort.on('message',data=>{const event={data,stopPropagation(){},stopImmediatePropagation(){},preventDefault(){}};globalThis.onmessage?.(event);for(const fn of listeners.get('message')??[])fn(event)});\n`;
  const thread=new Worker(prefix+result.outputFiles[0].text+'\nparentPort.postMessage({fixtureReady:true});',{eval:true});
  let serial=0;const pending=new Map();
  const ready=new Promise((resolve,reject)=>{thread.once('error',reject);const handle=value=>{if(value?.fixtureReady){thread.off('message',handle);resolve();}};thread.on('message',handle);});
  thread.on('message',message=>{if(message.type!==1)return;const item=pending.get(message.seq);if(!item)return;pending.delete(message.seq);clearTimeout(item.timer);if(message.err)item.reject(new Error(message.err.message??String(message.err)));else item.resolve(message.res);});
  thread.on('error',error=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();});
  await ready;
  const request=(method,args=[])=>new Promise((resolve,reject)=>{const req=String(++serial),timer=setTimeout(()=>{pending.delete(req);reject(new Error('Real language worker timed out: '+method));},15000);pending.set(req,{resolve,reject,timer});thread.postMessage({vsWorker:1,type:0,req,channel:'default',method,args});});
  const initialize=async(createData={})=>{thread.postMessage('ignore');thread.postMessage(createData);await request('$initialize',[1]);};
  return{request,initialize,async close(){for(const item of pending.values())clearTimeout(item.timer);pending.clear();await thread.terminate();}};
}
async function typescriptFixture(filename,text){
  const instance=await worker('typescript');await instance.initialize({compilerOptions:{allowJs:true},extraLibs:{},inlayHintsOptions:{}});
  await instance.request('$acceptNewModel',[{url:filename,versionId:1,lines:text.split('\n'),EOL:'\n'}]);return instance;
}
test('a generic editor worker reproduces the reported missing getNavigationTree failure',async()=>{
  const instance=await worker('editor');try{await instance.initialize();await assert.rejects(instance.request('$fmr',['getNavigationTree',['file:///fixture.ts']]),/Missing requestHandler or method: getNavigationTree/);}finally{await instance.close();}
});
test('real TypeScript worker answers the exact getNavigationTree RPC for TypeScript and JavaScript',async()=>{
  for(const[filename,text,symbol]of [['file:///fixture.ts','export function greet(name: string) { return name; }','greet'],['file:///fixture.js','function run() { return 42; }','run']]){
    const instance=await typescriptFixture(filename,text);try{const outline=await instance.request('$fmr',['getNavigationTree',[filename]]);assert.ok(outline.childItems.some(item=>item.text===symbol),filename+' must return its real outline');const syntactic=await instance.request('$fmr',['getSyntacticDiagnostics',[filename]]);assert.deepEqual(syntactic,[]);}finally{await instance.close();}
  }
});
test('real JSON, CSS and HTML workers execute their own language requests',async()=>{
  for(const[kind,text,method,data]of [
    ['json','{"name": }','doValidation',{languageId:'json',languageSettings:{validate:true},enableSchemaRequest:false}],
    ['css','a { color: }','doValidation',{languageId:'css',options:{validate:true}}],
    ['html','<main><span>Hello</span></main>','findDocumentSymbols',{languageId:'html',languageSettings:{}}]
  ]){
    const instance=await worker(kind),filename='file:///fixture.'+kind;
    try{await instance.initialize(data);await instance.request('$acceptNewModel',[{url:filename,versionId:1,lines:[text],EOL:'\n'}]);const result=await instance.request('$fmr',[method,[filename]]);assert.ok(Array.isArray(result)&&result.length>0,kind+' must return real language results');}finally{await instance.close();}
  }
});
