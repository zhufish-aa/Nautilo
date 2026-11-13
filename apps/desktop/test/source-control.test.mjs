import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const require=createRequire(import.meta.url);let JSDOM;
try{({JSDOM}=require(process.env.NAUTILO_JSDOM_PATH??'jsdom'));}catch{}
const until=async(predicate)=>{const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'source control UI did not settle');await new Promise(resolve=>setTimeout(resolve,15));}};
const file=(path,indexStatus='.',worktreeStatus='M')=>({path,indexStatus,worktreeStatus,untracked:worktreeStatus==='?',conflict:false,submodule:false});
const repository=()=>({schemaVersion:1,available:true,workingDirectory:'D:\\fixture',rootPath:'D:\\fixture',token:'state-1',branch:'main',head:'a'.repeat(40),ahead:0,behind:0,changes:[file('file.txt','M','M'),file('new.txt','?','?')],branches:[{name:'main',current:true}],recent:[],remotes:[],detached:false});
let bundlePromise;
async function fixture({initial=repository(),request}={}){
  const desktop=fileURLToPath(new URL('..',import.meta.url));
  bundlePromise??=createRequire(require.resolve('vite/package.json'))('esbuild').build({stdin:{loader:'tsx',resolveDir:desktop,contents:`
    import React from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{I18nProvider}from'./src/renderer/src/lib/i18n';
    import{SourceControlDrawer}from'./src/renderer/src/features/sessions/SourceControlDrawer';import{SourceControlDiffView}from'./src/renderer/src/features/sessions/SourceControlDiffView';import{useFilePreviewStore}from'./src/renderer/src/stores/file-preview';import{useCoreFeatures}from'./src/renderer/src/lib/use-core-features';
    function Features(){const features=useCoreFeatures();return features.sourceControl===1?<button data-feature='scm'>Source control</button>:null}
    const root=createRoot(document.getElementById('root'));let sessionId='s';let open=true;
    window.qa={calls:[],render(){flushSync(()=>root.render(<I18nProvider><SourceControlDrawer open={open} sessionId={sessionId} onClose={()=>window.qa.hide()}/></I18nProvider>))},features(){flushSync(()=>root.render(<><Features/><Features/></>))},hide(){open=false;this.render()},show(){open=true;this.render()},scope(id){sessionId=id;this.render()},preview(){return useFilePreviewStore.getState().target},patch(text){flushSync(()=>root.render(<SourceControlDiffView patch={text} scope='large'/>))},close(){flushSync(()=>root.unmount())}};
  `},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,nodePaths:[join(desktop,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},loader:{'.css':'empty'},plugins:[{name:'scm-ui-fixture',setup(b){
    b.onResolve({filter:/components\/ui\/(Dialog|Select)$/},args=>({path:args.path.endsWith('Dialog')?'dialog':'select',namespace:'fixture'}));
    b.onResolve({filter:/stores\/projects$/},()=>({path:'projects',namespace:'fixture'}));
    b.onResolve({filter:/components\/ui\/DiffCodeEditor$/},()=>({path:'code',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'tsx',resolveDir:desktop,contents:args.path==='code'?`export default function Code({before,value,filePath,readOnly,sideBySide,onChange}){return <div data-code-preview data-file={filePath} data-read-only={String(readOnly)} data-layout={sideBySide?'split':'unified'}><pre data-before>{before}</pre>{!readOnly&&onChange?<textarea aria-label='合并结果编辑器' value={value} onChange={event=>onChange(event.target.value)}/>:<pre data-after>{value}</pre>}</div>}`:args.path==='projects'?`export const useProjectsStore={getState:()=>({rescanProject:async()=>{}})};`:args.path==='dialog'?`export function Dialog({open,title,description,children,footer}){return open?<div role='dialog' aria-label={title}><h2>{title}</h2><p>{description}</p>{children}{footer}</div>:null}`:`export function SelectField({value,onValueChange,options,disabled,'aria-label':label}){return <select aria-label={label} value={value} disabled={disabled} onChange={event=>onValueChange(event.target.value)}>{options.map(option=><option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select>}`}));
  }}]});
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;let state=initial;
  w.ResizeObserver=class{observe(){}disconnect(){}};w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});w.HTMLElement.prototype.scrollTo=()=>{};
  const base=async(method,input)=>{
    if(method==='health.get')return{status:'ok',features:{sourceControl:1,sourceControlHistory:1,sourceControlEditing:1}};
    if(method==='scm.status')return structuredClone(state);
    if(method==='scm.diff')return{path:input.path,source:input.source,patch:`--- a/${input.path}\n+++ b/${input.path}\n@@ -1 +1 @@\n-old\n+${input.source==='index'?'staged':'working'}\n`,fileToken:input.source==='worktree'?'file-1':undefined,binary:false,truncated:false};
    if(method==='scm.mutate'){state={...state,token:'state-2',changes:input.action==='commit'?state.changes.map(item=>({...item,indexStatus:'.'})):input.action==='stage'?state.changes.map(item=>input.paths.includes(item.path)?{...item,indexStatus:item.untracked?'A':item.worktreeStatus,worktreeStatus:'.',untracked:false}:item):input.action==='unstage'?state.changes.map(item=>input.paths.includes(item.path)?{...item,indexStatus:'.',worktreeStatus:'M'}:item):state.changes};return{status:structuredClone(state)};}
    throw new Error('Unexpected request '+method);
  };
  w.agenthub={core:{request:async({method,input})=>{w.qa.calls.push({method,input});return request?request(method,input,base):base(method,input);}}};
  w.eval((await bundlePromise).outputFiles[0].text);w.qa.render();
  return{w,base,setState(value){state=value},button(label){return w.document.querySelector(`button[aria-label="${label}"]`)},byText(text){return [...w.document.querySelectorAll('button')].find(button=>button.textContent.trim()===text)},calls(method){return w.qa.calls.filter(call=>call.method===method)},close(){w.qa.close();w.close()}};
}
function inputText(w,node,value){Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}));}

test('commit submits only the staged index, keeps working changes and clears its draft',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    await until(()=>w.document.querySelector('textarea'));const area=w.document.querySelector('textarea');inputText(w,area,'Quoted "subject"\n\nBody');await until(()=>!f.byText('提交所选 (1)').disabled);
    f.byText('提交所选 (1)').click();await until(()=>w.document.body.textContent.includes('所选更改已提交'));
    const actions=f.calls('scm.mutate');assert.equal(actions.length,1);assert.equal(actions[0].input.action,'commit');assert.equal(actions[0].input.message,'Quoted "subject"\n\nBody');assert.equal(actions[0].input.paths,undefined);
    assert.equal(w.document.querySelector('textarea').value,'');assert.ok(f.button('查看文件差异 file.txt'));assert.ok(f.button('查看文件差异 new.txt'));assert.equal(f.byText('提交所选 (0)').disabled,true);
  }finally{f.close();}
});
test('staged and worktree diffs stay separate while a different source is loading',{skip:!JSDOM},async()=>{
  let release;const f=await fixture({request:(method,input,base)=>method==='scm.diff'&&input.source==='index'?new Promise(resolve=>{release=()=>base(method,input).then(resolve)}):base(method,input)});const{w}=f;
  try{
    await until(()=>w.document.querySelector('.scm-diff-code')?.textContent.includes('+working'));f.button('查看已选更改').click();await until(()=>release);
    assert.equal(w.document.querySelector('.scm-diff-code')?.textContent.includes('+working')??false,false,'do not label a working patch as a staged patch');
    release();await until(()=>w.document.querySelector('.scm-diff-code')?.textContent.includes('+staged'));assert.match(w.document.querySelector('.scm-diff-source').textContent,/此次提交的内容/);
  }finally{f.close();}
});
test('discard confirmation retains the reviewed file token across refresh and preserves new edits',{skip:!JSDOM},async()=>{
  let changed=false;const f=await fixture({request:async(method,input,base)=>{if(method==='scm.diff'&&changed)return{...(await base(method,input)),fileToken:'file-2',patch:'+new edit\n'};if(method==='scm.mutate')throw new Error('文件内容已改变，请重新查看差异');return base(method,input)}});const{w}=f;
  try{
    await until(()=>f.button('放弃所选文件的未暂存更改')&&!f.button('放弃所选文件的未暂存更改').disabled);f.button('放弃所选文件的未暂存更改').click();await until(()=>w.document.querySelector('[role="dialog"]'));
    changed=true;f.setState({...repository(),token:'state-2'});f.button('刷新仓库状态').click();await until(()=>w.document.querySelector('.scm-diff-code')?.textContent.includes('+new edit'));
    f.byText('放弃更改').click();await until(()=>w.document.querySelector('[role="alert"]')?.textContent.includes('文件内容已改变'));
    const action=f.calls('scm.mutate')[0].input;assert.equal(action.fileToken,'file-1');assert.equal(action.token,'state-1');assert.equal(action.paths.join(','),'file.txt');assert.ok(w.document.querySelector('[role="dialog"]'));assert.match(w.document.querySelector('.scm-diff-code').textContent,/new edit/);
  }finally{f.close();}
});
test('late responses from another session cannot replace the selected worktree',{skip:!JSDOM},async()=>{
  let release;const f=await fixture({request:(method,input,base)=>{if(method==='scm.status'&&input.sessionId==='s')return new Promise(resolve=>{release=()=>resolve(repository())});if(method==='scm.status')return{...repository(),rootPath:'D:\\worktrees\\feature',workingDirectory:'D:\\worktrees\\feature'};return base(method,input)}});const{w}=f;
  try{
    await until(()=>release);w.qa.scope('feature');await until(()=>w.document.querySelector('.scm-root')?.title.includes('feature'));release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(w.document.querySelector('.scm-root').title,'D:\\worktrees\\feature');
    f.button('打开所选文件').click();assert.equal(w.qa.preview().path,'D:\\worktrees\\feature/file.txt');assert.equal(f.calls('scm.mutate').length,0);
  }finally{f.close();}
});
test('large patches render a bounded window and remain readable at the end',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    w.qa.patch(Array.from({length:10000},(_,index)=>`+line-${index}`).join('\n'));await until(()=>w.document.querySelector('.scm-diff-code'));
    assert.ok(w.document.querySelectorAll('[data-line]').length<100);const surface=w.document.querySelector('.scm-diff-code');surface.scrollTop=199800;surface.dispatchEvent(new w.Event('scroll',{bubbles:true}));
    await until(()=>w.document.querySelector('[data-line="10000"]'));assert.ok(w.document.querySelectorAll('[data-line]').length<100);assert.match(w.document.querySelector('[data-line="10000"]').textContent,/line-9999/);
  }finally{f.close();}
});
test('unversioned folders initialize only after an explicit user action',{skip:!JSDOM},async()=>{
  let initialized=false;const empty={schemaVersion:1,available:false,workingDirectory:'D:\\fixture'};
  const f=await fixture({initial:empty,request:(method,input,base)=>{const status=initialized?{...repository(),changes:[]}:empty;if(method==='scm.status')return status;if(method==='scm.mutate'){assert.equal(input.action,'init');initialized=true;return{status:{...repository(),changes:[]}};}return base(method,input)}});
  try{await until(()=>f.byText('初始化 Git 仓库'));assert.equal(f.calls('scm.mutate').length,0);f.byText('初始化 Git 仓库').click();await until(()=>f.w.document.querySelector('textarea'));assert.equal(f.calls('scm.mutate').length,1);}finally{f.close();}
});
test('a resolved merge can be committed even when its staged tree matches HEAD',{skip:!JSDOM},async()=>{
  const f=await fixture({initial:{...repository(),changes:[],operation:'merge'}});
  try{await until(()=>f.w.document.querySelector('textarea'));inputText(f.w,f.w.document.querySelector('textarea'),'Finish merge');await until(()=>!f.byText('完成合并').disabled);f.byText('完成合并').click();await until(()=>f.calls('scm.mutate').length===1);assert.equal(f.calls('scm.mutate')[0].input.action,'commit');}finally{f.close();}
});
test('a resolved rebase points to continuation instead of claiming unresolved file conflicts',{skip:!JSDOM},async()=>{const f=await fixture({initial:{...repository(),operation:'rebase',changes:[file('file.txt','M','.')]}});try{await until(()=>f.w.document.querySelector('.scm-operation'));assert.match(f.w.document.querySelector('.scm-operation').textContent,/请在终端继续/);assert.doesNotMatch(f.w.document.querySelector('.scm-operation').textContent,/请先处理冲突/);inputText(f.w,f.w.document.querySelector('textarea'),'Continue rebase');assert.equal(f.byText('提交所选 (1)').disabled,true);assert.equal(f.calls('scm.mutate').length,0);}finally{f.close();}});
test('new source-control entry points require the backend feature declaration',{skip:!JSDOM},async()=>{
  for(const enabled of [false,true]){
    const f=await fixture({request:(method,input,base)=>method==='health.get'?{status:'ok',features:enabled?{sourceControl:1}:{}}:base(method,input)});
    try{f.w.qa.features();await until(()=>f.calls('health.get').length===1);if(enabled)await until(()=>f.w.document.querySelectorAll('[data-feature="scm"]').length===2);else assert.equal(f.w.document.querySelectorAll('[data-feature="scm"]').length,0);assert.equal(f.calls('health.get').length,1,'feature lookup is shared between views');}finally{f.close();}
  }
});
test('source control view tabs support keyboard navigation and retain focus',{skip:!JSDOM},async()=>{
  const f=await fixture();
  try{await until(()=>f.w.document.querySelector('[data-view="changes"]'));const tab=f.w.document.querySelector('[data-view="changes"]');tab.focus();tab.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await until(()=>f.w.document.querySelector('[data-view="history"]').getAttribute('aria-selected')==='true');assert.equal(f.w.document.activeElement.dataset.view,'history');assert.equal(f.w.document.querySelector('[data-view="changes"]').tabIndex,-1);}finally{f.close();}
});
test('remote selection follows the native upstream instead of defaulting to origin',{skip:!JSDOM},async()=>{
  const f=await fixture({initial:{...repository(),upstream:'fork/main',upstreamRemote:'fork',remotes:['origin','fork']}});
  try{await until(()=>f.w.document.querySelector('select[aria-label="远程仓库"]')?.value==='fork');f.byText('推送').click();await until(()=>f.calls('scm.mutate').length===1);assert.equal(f.calls('scm.mutate')[0].input.remote,'fork');}finally{f.close();}
});
test('fetch and push keep separate destinations for a native fork workflow',{skip:!JSDOM},async()=>{
  const f=await fixture({initial:{...repository(),upstream:'origin/main',upstreamRemote:'origin',pushRemote:'fork',remotes:['origin','fork']}});
  try{await until(()=>f.w.document.querySelector('select[aria-label="推送目标"]')?.value==='fork');assert.equal(f.w.document.querySelector('select[aria-label="远程仓库"]').value,'origin');f.byText('推送').click();await until(()=>f.calls('scm.mutate').length===1);assert.equal(f.calls('scm.mutate')[0].input.remote,'fork');}finally{f.close();}
});
test('hunk and line controls send the reviewed patch identity and preserve source direction',{skip:!JSDOM},async()=>{
  const f=await fixture({request:async(method,input,base)=>{const result=await base(method,input);return method==='scm.diff'?{...result,patchToken:'reviewed-patch',hunks:[{id:'hunk-1',header:'@@ -1 +1 @@',startLine:3,endLine:5}]}:result;}});
  try{
    await until(()=>f.byText('按行选择'));f.byText('按行选择').click();
    await until(()=>f.button('暂存区块 3')&&!f.button('暂存区块 3').disabled);f.button('暂存区块 3').click();await until(()=>f.calls('scm.mutate').length===1);
    let action=f.calls('scm.mutate')[0].input;assert.equal(action.action,'stage-hunks');assert.equal(action.patchToken,'reviewed-patch');assert.equal(action.hunkIds.join(','),'hunk-1');assert.equal(action.paths.join(','),'file.txt');
    f.button('查看已选更改').click();await until(()=>f.w.document.querySelector('.scm-diff-source')?.textContent.includes('此次提交的内容')&&f.byText('按行选择'));f.byText('按行选择').click();await until(()=>f.w.document.querySelector('input[aria-label="选择更改行 5"]')&&!f.w.document.querySelector('input[aria-label="选择更改行 5"]').disabled);
    f.w.document.querySelector('input[aria-label="选择更改行 5"]').click();await until(()=>f.byText('取消暂存选中行')&&!f.byText('取消暂存选中行').disabled);f.byText('取消暂存选中行').click();await until(()=>f.calls('scm.mutate').length===2);
    action=f.calls('scm.mutate')[1].input;assert.equal(action.action,'unstage-hunks');assert.equal(action.lines.join(','),'5');assert.equal(action.patchToken,'reviewed-patch');
  }finally{f.close();}
});
test('working and staged groups keep partial changes separate and submit only the native index',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    const checkbox=(label,group)=>w.document.querySelector(`[data-group="${group}"] input[aria-label="选择提交文件 ${label}"]`);
    await until(()=>checkbox('file.txt','index'));assert.equal(checkbox('file.txt','index').checked,true);assert.equal(checkbox('file.txt','worktree').checked,false);assert.equal(checkbox('new.txt','untracked').checked,false);
    checkbox('new.txt','untracked').click();await until(()=>checkbox('new.txt','index')?.checked);assert.equal(f.calls('scm.mutate')[0].input.action,'stage');assert.deepEqual(Array.from(f.calls('scm.mutate')[0].input.paths),['new.txt']);
    checkbox('file.txt','index').click();await until(()=>!checkbox('file.txt','index'));assert.equal(f.calls('scm.mutate')[1].input.action,'unstage');assert.deepEqual(Array.from(f.calls('scm.mutate')[1].input.paths),['file.txt']);
    inputText(w,w.document.querySelector('textarea'),'Only the chosen file');await until(()=>!f.byText('提交所选 (1)').disabled);f.byText('提交所选 (1)').click();await until(()=>f.calls('scm.mutate').length===3);assert.equal(f.calls('scm.mutate')[2].input.action,'commit');assert.equal(f.calls('scm.mutate')[2].input.paths,undefined);
    assert.equal(w.document.querySelectorAll('.scm-file-row').length,2,'one row per file, including partial changes');assert.equal(f.button('暂存 new.txt'),null);
  }finally{f.close();}
});
test('unchanged status refreshes and revisiting a file do not reload its diff',{skip:!JSDOM},async()=>{
  const f=await fixture();try{
    await until(()=>f.w.document.querySelector('.scm-diff-code')?.textContent.includes('+working'));assert.equal(f.calls('scm.diff').length,1);
    f.button('刷新仓库状态').click();await until(()=>f.calls('scm.status').length===2);await new Promise(resolve=>setTimeout(resolve,25));assert.equal(f.calls('scm.diff').length,1);
    f.button('查看文件差异 new.txt').click();await until(()=>f.calls('scm.diff').length===2);f.button('查看文件差异 file.txt').click();await until(()=>f.w.document.querySelector('.scm-preview-file')?.textContent.includes('file.txt'));assert.equal(f.calls('scm.diff').length,2);
    f.w.qa.hide();f.w.qa.show();await until(()=>f.w.document.querySelector('textarea'));assert.equal(f.calls('scm.diff').length,2);
  }finally{f.close();}
});
test('staging another file while Git is busy queues its intent against the fresh index token',{skip:!JSDOM},async()=>{
  let release;const f=await fixture({request:(method,input,base)=>method==='scm.mutate'&&input.action==='stage'&&input.paths.includes('new.txt')?new Promise(resolve=>{release=()=>base(method,input).then(resolve);}):base(method,input)});
  try{
    const checkbox=(path,group)=>f.w.document.querySelector(`[data-group="${group}"] input[aria-label="选择提交文件 ${path}"]`);
    await until(()=>checkbox('new.txt','untracked'));checkbox('new.txt','untracked').click();await until(()=>release);
    assert.equal(checkbox('file.txt','index').disabled,false);checkbox('file.txt','index').click();assert.equal(f.calls('scm.mutate').length,1);
    release();await until(()=>f.calls('scm.mutate').length===2&&!checkbox('file.txt','index'));
    assert.equal(f.calls('scm.mutate')[1].input.action,'unstage');assert.equal(f.calls('scm.mutate')[1].input.token,'state-2');
  }finally{f.close();}
});
test('commit-and-push waits for a successful native commit and uses its new token',{skip:!JSDOM},async()=>{
  const f=await fixture({initial:{...repository(),remotes:['origin'],upstream:'origin/main',upstreamRemote:'origin'}});
  try{await until(()=>f.w.document.querySelector('textarea'));inputText(f.w,f.w.document.querySelector('textarea'),'Selected fix');await until(()=>!f.byText('提交并推送').disabled);f.byText('提交并推送').click();await until(()=>f.calls('scm.mutate').length===2);assert.deepEqual(Array.from(f.calls('scm.mutate'),item=>item.input.action),['commit','push']);assert.equal(f.calls('scm.mutate')[1].input.token,'state-2');}finally{f.close();}
});
test('a successful commit keeps a newer message draft typed while the commit was pending',{skip:!JSDOM},async()=>{
  let release;const f=await fixture({request:(method,input,base)=>method==='scm.mutate'&&input.action==='commit'?new Promise(resolve=>{release=()=>base(method,input).then(resolve);}):base(method,input)});
  try{await until(()=>f.w.document.querySelector('textarea'));inputText(f.w,f.w.document.querySelector('textarea'),'Submitted message');await until(()=>!f.byText('提交所选 (1)').disabled);f.byText('提交所选 (1)').click();await until(()=>release);inputText(f.w,f.w.document.querySelector('textarea'),'Next commit draft');release();await until(()=>f.w.document.body.textContent.includes('所选更改已提交'));assert.equal(f.w.document.querySelector('textarea').value,'Next commit draft');}finally{f.close();}
});
test('code previews use complete file versions in a read-only syntax editor and keep advanced controls secondary',{skip:!JSDOM},async()=>{
  const f=await fixture({request:async(method,input,base)=>{const value=await base(method,input);return method==='scm.diff'?{...value,before:'const version = 1;\n',after:'const version = 2;\n',patchToken:'reviewed',hunks:[{id:'hunk',header:'@@ -1 +1 @@',startLine:3,endLine:5}]}:value;}});
  try{
    await until(()=>f.w.document.querySelector('[data-code-preview]'));const code=f.w.document.querySelector('[data-code-preview]');assert.equal(code.dataset.file,'file.txt');assert.equal(code.dataset.readOnly,'true');assert.equal(code.dataset.layout,'unified');assert.equal(code.querySelector('[data-before]').textContent,'const version = 1;\n');assert.equal(code.querySelector('[data-after]').textContent,'const version = 2;\n');assert.equal(f.button('暂存区块 3'),null);
    f.byText('并排').click();await until(()=>f.w.document.querySelector('[data-code-preview]').dataset.layout==='split');f.byText('统一').click();await until(()=>f.w.document.querySelector('[data-code-preview]').dataset.layout==='unified');assert.equal(f.w.localStorage.getItem('nautilo.scm.diff.layout'),'unified');f.byText('按行选择').click();await until(()=>f.button('暂存区块 3'));assert.equal(f.w.document.querySelector('[data-code-preview]'),null);
  }finally{f.close();}
});
test('paged history keeps the selected older diff across polls and ignores superseded searches', {skip:!JSDOM}, async () => {
  const summary = (id, subject) => ({hash:id.repeat(40), subject, author:'Fixture', committedAt:'2026-11-02T12:30:00Z'});
  const recent = summary('a', 'Recent'), older = summary('b', 'Older'), latest = summary('c', 'New tip');
  let state = {...repository(), recent:[recent]};
  let finishSlow;
  const f = await fixture({initial:state, request(method, input, base) {
    if (method === 'health.get') return {features:{sourceControl:1,sourceControlHistory:1,sourceControlHistoryPaging:1}};
    if (method === 'scm.status') return structuredClone(state);
    if (method === 'scm.history') {
      const page = {rootPath:state.rootPath, reference:'refs/heads/'+state.branch, query:input.query, head:state.head, currentHead:state.head};
      if (input.query === 'slow') return new Promise(resolve => {finishSlow = () => resolve({...page,items:[recent]});});
      if (input.query) return {...page,items:input.query === 'older' ? [older] : []};
      if (input.cursor) return {...page,items:[older]};
      return {...page,items:state.recent,nextCursor:'next'};
    }
    if (method === 'scm.commit') return {rootPath:state.rootPath, ...[recent,older,latest].find(c=>c.hash===input.hash),
      body:'',parents:[],authorEmail:'a@example.invalid',files:[{path:input.hash[0]+'.ts',status:'A',binary:false,additions:1,deletions:0}]};
    if (method === 'scm.commitDiff') return {rootPath:state.rootPath,path:input.path,source:'commit',commitHash:input.hash,
      binary:false,truncated:false,patch:'',before:'',after:input.path};
    return base(method,input);
  }});
  try {
    const {w} = f;
    await until(()=>w.document.querySelector('[data-view="history"]'));
    w.document.querySelector('[data-view="history"]').click();
    await until(()=>f.byText('加载更多'));
    f.byText('加载更多').click();
    await until(()=>f.button('查看提交 bbbbbbbb'));
    f.button('查看提交 bbbbbbbb').click();
    const preview = () => w.document.querySelector('[data-code-preview]')?.dataset.file;
    await until(()=>preview()==='b.ts');
    state = {...state,head:latest.hash,recent:[latest,recent]};
    w.dispatchEvent(new w.Event('focus'));
    await until(()=>f.byText('有更新，刷新'));
    assert.equal(preview(),'b.ts');
    assert.equal(f.calls('scm.history').length,2);
    f.byText('有更新，刷新').click();
    await until(()=>f.button('查看提交 cccccccc'));
    const search = w.document.querySelector('input[aria-label="搜索提交记录"]');
    const type = (value) => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(search,value);
      search.dispatchEvent(new w.Event('input',{bubbles:true}));
    };
    type('slow');
    await until(()=>finishSlow);
    type('ol'); type('older');
    await until(()=>preview()==='b.ts');
    finishSlow();
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(preview(),'b.ts');
    assert.equal(f.calls('scm.history').some(call=>call.input.query==='ol'),false);
    assert.equal(w.document.querySelectorAll('.scm-history-row').length,1);
    type('missing');
    await until(()=>w.document.body.textContent.includes('没有匹配的提交'));
    assert.equal(preview(),undefined);
  } finally { f.close(); }
});

test('commit history opens changed files and ignores late details from a previously selected commit',{skip:!JSDOM},async()=>{
  const first='a'.repeat(40),second='b'.repeat(40);let release;
  const f=await fixture({initial:{...repository(),recent:[{hash:first,subject:'Old commit',author:'Fixture',committedAt:'2026-11-01T01:00:00Z'},{hash:second,subject:'Selected commit',author:'Fixture',committedAt:'2026-11-02T01:00:00Z'}]},request:(method,input,base)=>{
    const detail=hash=>({rootPath:repository().rootPath,hash,parents:['c'.repeat(40)],subject:hash===first?'Old commit':'Selected commit',body:'Commit body',author:'Fixture',authorEmail:'fixture@example.invalid',committedAt:'2026-11-02T01:00:00Z',files:[{path:hash===first?'old.ts':'src/selected.rs',status:'M',binary:false,additions:1,deletions:1},{path:'src/second.rs',status:'A',binary:false,additions:1,deletions:0}]});
    if(method==='scm.commit')return input.hash===first?new Promise(resolve=>{release=()=>resolve(detail(first))}):detail(second);
    if(method==='scm.commitDiff')return{rootPath:repository().rootPath,path:input.path,source:'commit',commitHash:input.hash,binary:false,truncated:false,patch:'',before:'before\n',after:input.path+' after\n'};
    return base(method,input);
  }});
  try{
    await until(()=>f.w.document.querySelector('[data-view="history"]'));f.w.document.querySelector('[data-view="history"]').click();await until(()=>release);f.button('查看提交 bbbbbbbb').click();await until(()=>f.button('查看提交文件 src/selected.rs')&&f.w.document.querySelector('[data-code-preview]'));
    assert.equal(f.w.document.querySelector('.scm-commit-details h3').textContent,'Selected commit');assert.equal(f.w.document.querySelector('[data-code-preview]').dataset.file,'src/selected.rs');release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.button('查看提交文件 old.ts'),null);
    f.byText('完整提交说明').click();await until(()=>f.w.document.querySelector('.scm-commit-message')?.textContent==='Commit body');assert.equal(f.w.document.querySelector('.scm-commit-message-toggle').getAttribute('aria-expanded'),'true');
    f.button('查看提交文件 src/second.rs').click();await until(()=>f.w.document.querySelector('[data-code-preview]')?.dataset.file==='src/second.rs');assert.equal(f.calls('scm.commitDiff').at(-1).input.hash,second);assert.equal(f.calls('scm.mutate').length,0);
  }finally{f.close();}
});
test('pane borders resize with pointer and keyboard, persist widths and restore after reopening',{skip:!JSDOM},async()=>{
  const f=await fixture();const{w}=f;
  try{
    await until(()=>w.document.querySelector('[aria-label="调整源码管理宽度"]'));const edge=w.document.querySelector('[aria-label="调整源码管理宽度"]'),start=Number(edge.getAttribute('aria-valuenow'));
    edge.dispatchEvent(new w.MouseEvent('pointerdown',{button:0,clientX:300,bubbles:true}));edge.dispatchEvent(new w.MouseEvent('pointermove',{clientX:360,bubbles:true}));edge.dispatchEvent(new w.MouseEvent('pointerup',{clientX:360,bubbles:true}));await until(()=>Number(edge.getAttribute('aria-valuenow'))===start-60);assert.equal(w.localStorage.getItem('nautilo.scm.panel.width'),String(start-60));assert.equal(w.document.body.style.cursor,'');
    const files=w.document.querySelector('[aria-label="调整文件列表宽度"]');files.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await until(()=>files.getAttribute('aria-valuenow')==='296');assert.equal(w.localStorage.getItem('nautilo.scm.files.width'),'296');w.qa.hide();w.qa.show();await until(()=>w.document.querySelector('[aria-label="调整文件列表宽度"]'));assert.equal(w.document.querySelector('[aria-label="调整文件列表宽度"]').getAttribute('aria-valuenow'),'296');assert.equal(w.document.querySelector('[aria-label="调整源码管理宽度"]').getAttribute('aria-valuenow'),String(start-60));
    f.button('最大化源码管理').click();await until(()=>w.document.querySelector('.workspace-panel-right.is-maximized'));f.button('还原源码管理').click();await until(()=>!w.document.querySelector('.workspace-panel-right.is-maximized'));
  }finally{f.close();}
});
const editorRepository=()=>({...repository(),changes:[{...file('file.txt','U','U'),conflict:true}]});
const editorVersion=content=>({exists:true,binary:false,truncated:false,mode:'100644',content});
const editorFile=(token='version-1')=>({rootPath:repository().rootPath,path:'file.txt',token,conflict:true,editable:true,working:editorVersion('<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> feature\n'),base:editorVersion('base\n'),ours:editorVersion('current\n'),theirs:editorVersion('incoming\n'),index:{exists:false,binary:false,truncated:false}});
const editorArea=w=>w.document.querySelector('textarea[aria-label="合并结果编辑器"]');
async function openEditor(f){await until(()=>f.button('解决所选文件冲突')&&!f.button('解决所选文件冲突').disabled);f.button('解决所选文件冲突').click();await until(()=>f.w.document.querySelector('.scm-editor-controls'));}
test('conflict editor preserves a draft across returning to diff, saves without staging, then resolves',{skip:!JSDOM},async()=>{
  let current=editorFile(),repo=editorRepository();const f=await fixture({initial:repo,request:(method,input,base)=>{if(method==='scm.status')return structuredClone(repo);if(method==='scm.file')return structuredClone(current);if(method==='scm.save'){current={...current,token:input.stage?'version-3':'version-2',working:editorVersion(input.content),conflict:!input.stage};repo={...repo,token:current.token,changes:input.stage?[file('file.txt','M','.')]:repo.changes};return{saved:true,staged:input.stage,file:structuredClone(current),status:structuredClone(repo)};}return base(method,input);}});
  try{await openEditor(f);await until(()=>editorArea(f.w));inputText(f.w,editorArea(f.w),'manual result\n');await until(()=>editorArea(f.w)?.value==='manual result\n');f.button('返回差异并保留草稿').click();await until(()=>!f.w.document.querySelector('.scm-editor'));await openEditor(f);await until(()=>editorArea(f.w)?.value==='manual result\n');assert.equal(f.calls('scm.save').length,0);f.byText('保存文件').click();await until(()=>f.w.document.querySelector('.scm-notice')?.textContent.includes('尚未加入'));let input=f.calls('scm.save')[0].input;assert.equal(input.stage,false);assert.equal(input.fileVersion,'version-1');assert.equal(input.content,'manual result\n');assert.ok(f.w.document.querySelector('.scm-editor'));f.byText('保存并标记已解决').click();await until(()=>!f.w.document.querySelector('.scm-editor'));input=f.calls('scm.save')[1].input;assert.equal(input.stage,true);assert.equal(input.fileVersion,'version-2');assert.equal(f.calls('scm.mutate').length,0);
  }finally{f.close();}
});
test('conflict version choice stays local until save and can undo to the typed result',{skip:!JSDOM},async()=>{
  const f=await fixture({initial:editorRepository(),request:(method,input,base)=>method==='scm.file'?editorFile():base(method,input)});
  try{await openEditor(f);await until(()=>editorArea(f.w));inputText(f.w,editorArea(f.w),'typed draft\n');const select=f.w.document.querySelector('select[aria-label="合并对照版本"]');select.value='theirs';select.dispatchEvent(new f.w.Event('change',{bubbles:true}));await until(()=>f.w.document.querySelector('[data-before]')?.textContent==='incoming\n');f.byText('采用此版本').click();await until(()=>editorArea(f.w)?.value==='incoming\n');assert.equal(f.calls('scm.save').length,0);inputText(f.w,editorArea(f.w),'post choice edit\n');await until(()=>editorArea(f.w)?.value==='post choice edit\n');f.button('撤销采用版本').click();await until(()=>editorArea(f.w)?.value==='typed draft\n');f.button('重做采用版本').click();await until(()=>editorArea(f.w)?.value==='post choice edit\n');assert.equal(f.calls('scm.mutate').length,0);}finally{f.close();}
});
test('stale saves keep text, require fresh native versions and send the acknowledged file identity',{skip:!JSDOM},async()=>{
  let current=editorFile(),attempts=0;const f=await fixture({initial:editorRepository(),request:(method,input,base)=>{if(method==='scm.file')return structuredClone(current);if(method==='scm.save'){if(attempts++===0){current={...editorFile('version-2'),working:editorVersion('external edit\n')};throw new Error('文件内容已改变，请刷新后重试');}return{saved:true,staged:true,status:{...repository(),changes:[file('file.txt','M','.')]},file:{...current,conflict:false,token:'version-3',working:editorVersion(input.content)}};}return base(method,input);}});
  try{await openEditor(f);await until(()=>editorArea(f.w));inputText(f.w,editorArea(f.w),'keep my draft\n');f.byText('保存并标记已解决').click();await until(()=>f.w.document.querySelector('.scm-editor-stale'));assert.equal(editorArea(f.w).value,'keep my draft\n');assert.equal(f.byText('保存并标记已解决').disabled,true);f.byText('刷新对照，保留草稿').click();await until(()=>f.byText('已核对，采用最新对照'));assert.equal(editorArea(f.w).value,'keep my draft\n');assert.equal(f.w.document.querySelector('[data-before]').textContent,'external edit\n');f.byText('已核对，采用最新对照').click();await until(()=>!f.byText('保存并标记已解决').disabled);f.byText('保存并标记已解决').click();await until(()=>f.calls('scm.save').length===2);assert.equal(f.calls('scm.save')[1].input.fileVersion,'version-2');assert.equal(f.calls('scm.save')[1].input.content,'keep my draft\n');}finally{f.close();}
});
test('saved but unstaged results retain the editor and retry with the updated native identity',{skip:!JSDOM},async()=>{
  let attempts=0;const f=await fixture({initial:editorRepository(),request:(method,input,base)=>{if(method==='scm.file')return editorFile();if(method==='scm.save'){const fileData={...editorFile('version-2'),working:editorVersion(input.content)};return attempts++===0?{saved:true,staged:false,file:fileData,error:'文件已保存，但暂存失败：index locked'}:{saved:true,staged:true,file:{...fileData,conflict:false},status:{...repository(),changes:[file('file.txt','M','.')]}};}return base(method,input);}});
  try{await openEditor(f);await until(()=>editorArea(f.w));inputText(f.w,editorArea(f.w),'saved result\n');f.byText('保存并标记已解决').click();await until(()=>f.w.document.querySelector('.scm-error')?.textContent.includes('已保存')&&editorArea(f.w));assert.equal(editorArea(f.w).value,'saved result\n');assert.ok(f.w.document.querySelector('.scm-editor'));f.byText('保存并标记已解决').click();await until(()=>!f.w.document.querySelector('.scm-editor'));assert.equal(f.calls('scm.save')[1].input.fileVersion,'version-2');}finally{f.close();}
});
test('missing conflict side is an explicit deletion and sends no reconstructed text',{skip:!JSDOM},async()=>{
  const initial={...editorFile(),theirs:{exists:false,binary:false,truncated:false}};const f=await fixture({initial:editorRepository(),request:(method,input,base)=>{if(method==='scm.file')return initial;if(method==='scm.save')return{saved:true,staged:true,file:{...initial,token:'version-2',conflict:false,working:{exists:false,binary:false,truncated:false}},status:{...repository(),changes:[]}};return base(method,input);}});
  try{await openEditor(f);const select=f.w.document.querySelector('select[aria-label="合并对照版本"]');select.value='theirs';select.dispatchEvent(new f.w.Event('change',{bubbles:true}));await until(()=>f.byText('采用此方删除'));f.byText('采用此方删除').click();await until(()=>f.byText('删除并标记已解决'));assert.match(f.w.document.querySelector('.scm-editor-surface').textContent,/删除文件/);f.byText('删除并标记已解决').click();await until(()=>f.calls('scm.save').length===1);const sent=f.calls('scm.save')[0].input;assert.equal(sent.resolution,'theirs');assert.equal(sent.content,undefined);assert.equal(sent.stage,true);}finally{f.close();}
});
test('conflict entry requires an advertised editor capability and ignores late file responses',{skip:!JSDOM},async()=>{
  const old=await fixture({initial:editorRepository(),request:(method,input,base)=>method==='health.get'?{features:{sourceControl:1}}:base(method,input)});
  try{await until(()=>old.w.document.querySelector('.scm-file-row'));assert.equal(old.button('解决所选文件冲突'),null);assert.equal(old.calls('scm.file').length,0);}finally{old.close();}
  let release;const f=await fixture({initial:editorRepository(),request:(method,input,base)=>method==='scm.file'?new Promise(resolve=>{release=()=>resolve(editorFile())}):base(method,input)});
  try{await until(()=>f.button('解决所选文件冲突')&&!f.button('解决所选文件冲突').disabled);f.button('解决所选文件冲突').click();await until(()=>release);f.w.qa.scope('another');release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.w.document.querySelector('.scm-editor'),null);assert.equal(f.calls('scm.save').length,0);}finally{f.close();}
});
test('binary conflicts use a full native version instead of pretending to edit partial text',{skip:!JSDOM},async()=>{
  const version={exists:true,binary:true,truncated:false,mode:'100644'},data={...editorFile(),editable:false,working:version,ours:version,theirs:version,base:version};const f=await fixture({initial:editorRepository(),request:(method,input,base)=>method==='scm.file'?data:method==='scm.save'?{saved:true,staged:true,status:{...repository(),changes:[]},file:{...data,token:'version-2',conflict:false}}:base(method,input)});
  try{await openEditor(f);assert.equal(editorArea(f.w),null);assert.match(f.w.document.querySelector('.scm-editor-surface').textContent,/二进制/);assert.equal(f.byText('保存并标记已解决').disabled,true);const select=f.w.document.querySelector('select[aria-label="合并对照版本"]');select.value='theirs';select.dispatchEvent(new f.w.Event('change',{bubbles:true}));f.byText('采用此版本').click();await until(()=>!f.byText('保存并标记已解决').disabled);f.byText('保存并标记已解决').click();await until(()=>f.calls('scm.save').length===1);assert.equal(f.calls('scm.save')[0].input.resolution,'theirs');assert.equal(f.calls('scm.save')[0].input.content,undefined);}finally{f.close();}
});
test('draft storage failures are visible and a draft survives returning within the current app run',{skip:!JSDOM},async()=>{
  const f=await fixture({initial:editorRepository(),request:(method,input,base)=>method==='scm.file'?editorFile():base(method,input)});
  try{Object.defineProperty(f.w.Storage.prototype,'setItem',{value(){throw new Error('quota');}});await openEditor(f);await until(()=>editorArea(f.w));inputText(f.w,editorArea(f.w),'memory draft\n');await until(()=>f.w.document.querySelector('.scm-operation')?.textContent.includes('本次运行'));f.button('返回差异并保留草稿').click();await until(()=>!f.w.document.querySelector('.scm-editor'));const hiddenEvent=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(hiddenEvent);assert.equal(hiddenEvent.defaultPrevented,true,'closing must protect a draft even after leaving the editor');await openEditor(f);await until(()=>editorArea(f.w)?.value==='memory draft\n');const event=new f.w.Event('beforeunload',{cancelable:true});f.w.dispatchEvent(event);assert.equal(event.defaultPrevented,true);assert.equal(f.calls('scm.save').length,0);}finally{f.close();}
});
test('a draft remains reachable when an external commit or deletion removes its changed-file row',{skip:!JSDOM},async()=>{
  let unavailable=false;const f=await fixture({initial:editorRepository(),request:(method,input,base)=>{if(method==='scm.file'){if(unavailable)throw new Error('请选择一个 Git 文件');return editorFile();}return base(method,input);}});
  try{await openEditor(f);await until(()=>editorArea(f.w));inputText(f.w,editorArea(f.w),'recover after external change\n');f.setState({...repository(),changes:[]});f.button('刷新仓库状态').click();await until(()=>f.button('恢复文件草稿 file.txt'));assert.equal(editorArea(f.w).value,'recover after external change\n');f.button('返回差异并保留草稿').click();await until(()=>!f.w.document.querySelector('.scm-editor'));unavailable=true;f.button('恢复文件草稿 file.txt').click();await until(()=>f.w.document.querySelector('textarea[aria-label="保留的文件草稿"]'));assert.equal(f.w.document.querySelector('textarea[aria-label="保留的文件草稿"]').value,'recover after external change\n');assert.equal(f.calls('scm.save').length,0);}finally{f.close();}
});
