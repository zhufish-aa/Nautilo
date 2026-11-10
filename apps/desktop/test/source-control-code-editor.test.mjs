import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const require=createRequire(import.meta.url);let JSDOM;
try{({JSDOM}=require(process.env.NAUTILO_JSDOM_PATH??'jsdom'));}catch{}
let bundlePromise;
async function fixture(path='src/lib.rs'){
  const desktop=fileURLToPath(new URL('..',import.meta.url));
  bundlePromise??=createRequire(require.resolve('vite/package.json'))('esbuild').build({stdin:{loader:'tsx',resolveDir:desktop,contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import Diff from'./src/renderer/src/components/ui/DiffCodeEditor';
    const root=createRoot(document.getElementById('root'));window.qa={models:[],editors:[],themes:[],changes:[],props:{before:'fn before() {}',value:'fn after() {}',filePath:window.fixturePath,readOnly:true,sideBySide:true,hideUnchanged:true,onChange:value=>window.qa.changes.push(value)},render(){flushSync(()=>root.render(<Diff {...this.props}/>))},close(){flushSync(()=>root.unmount())}};
  `},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[join(desktop,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'monaco-contract',setup(b){
    b.onResolve({filter:/^monaco-editor$/},()=>({path:'monaco',namespace:'fixture'}));b.onResolve({filter:/\/(?:editor|ts|json|css|html)\.worker\.js\?worker&inline$/},args=>({path:args.path.split('/').at(-1).split('.')[0]+':worker',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.endsWith(':worker')?`export default class Worker{kind=${JSON.stringify(args.path.split(':')[0])}}`:`
      export const languages={getLanguages:()=>[{id:'rust',extensions:['.rs']},{id:'typescript',extensions:['.ts']},{id:'dockerfile',filenames:['Dockerfile']}]};
      export const editor={defineTheme(){},setTheme(theme){window.qa.themes.push(theme)},createModel(value,language){const model={value,language,disposed:false,getValue(){return this.value},setValue(value){this.value=value;this.changed?.()},onDidChangeContent(fn){this.changed=fn},dispose(){this.disposed=true}};window.qa.models.push(model);return model},createDiffEditor(node,options){const entry={options:{...options},disposed:false,setModel(models){this.models=models},onDidUpdateDiff(){return{dispose(){}}},getLineChanges(){return[]},getOriginalEditor(){return{}},updateOptions(next){Object.assign(this.options,next)},dispose(){this.disposed=true}};window.qa.editors.push(entry);return entry}};
    `}));
  }}]});
  const dom=new JSDOM('<div id="root"></div>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;w.fixturePath=path;w.eval((await bundlePromise).outputFiles[0].text);w.qa.render();return{w,close(){w.qa.close();w.close()}};
}
test('SCM code editor enables syntax languages, read-only diff and complete controlled versions',{skip:!JSDOM},async()=>{
  const f=await fixture();try{const{qa}=f.w;assert.deepEqual(Array.from(qa.models,model=>model.language),['rust','rust']);const editor=qa.editors[0];assert.equal(editor.options.readOnly,true);assert.equal(editor.options.originalEditable,false);assert.equal(editor.options.ignoreTrimWhitespace,false);assert.equal(editor.options.renderSideBySide,true);assert.equal(editor.options.hideUnchangedRegions.enabled,true);assert.equal(editor.options.renderIndicators,false);
    qa.props={...qa.props,before:'fn updated_before() {}',value:'fn updated_after() {}',sideBySide:false};qa.render();assert.equal(qa.editors.length,1,'refresh updates existing models without recreating the editor');assert.equal(editor.models.original.getValue(),'fn updated_before() {}');assert.equal(editor.models.modified.getValue(),'fn updated_after() {}');assert.equal(editor.options.renderSideBySide,false);
    f.w.document.documentElement.classList.add('dark');await new Promise(resolve=>setTimeout(resolve,0));assert.equal(qa.themes.at(-1),'agenthub-dark');qa.close();assert.ok(qa.models.every(model=>model.disposed));assert.equal(editor.disposed,true);
  }finally{f.close();}
});
test('filename-based syntax selection includes Dockerfile without an extension',{skip:!JSDOM},async()=>{const f=await fixture('Dockerfile');try{assert.deepEqual(Array.from(f.w.qa.models,model=>model.language),['dockerfile','dockerfile']);}finally{f.close();}});
test('language workers are routed to their own services, with the generic worker reserved for core editing',{skip:!JSDOM},async()=>{
  const f=await fixture();try{for(const[label,expected]of [['typescript','ts'],['javascript','ts'],['json','json'],['jsonc','json'],['css','css'],['scss','css'],['less','css'],['html','html'],['handlebars','html'],['razor','html'],['editorWorkerService','editor'],['rust','editor']]){const worker=await f.w.MonacoEnvironment.getWorker('worker',label);assert.equal(worker.kind,expected,label+' must use its matching worker');}}finally{f.close();}
});
test('editable diff emits result changes once and changing references preserves the result model',{skip:!JSDOM},async()=>{const f=await fixture();try{const qa=f.w.qa,editor=qa.editors[0];qa.props={...qa.props,readOnly:false};qa.render();assert.equal(editor.options.readOnly,false);assert.equal(editor.options.originalEditable,false);const result=editor.models.modified;result.setValue('typed merge result');assert.deepEqual(Array.from(qa.changes),['typed merge result']);qa.props={...qa.props,value:'typed merge result',before:'another reference'};qa.render();assert.equal(qa.editors.length,1);assert.equal(editor.models.modified,result);assert.equal(result.getValue(),'typed merge result');assert.deepEqual(Array.from(qa.changes),['typed merge result']);assert.equal(editor.models.original.getValue(),'another reference');}finally{f.close();}});
