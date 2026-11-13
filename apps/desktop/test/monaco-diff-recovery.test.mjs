import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require = createRequire(import.meta.url);
const {build} = createRequire(require.resolve('vite/package.json'))('esbuild');
const compiled = await build({entryPoints:[fileURLToPath(new URL('../src/renderer/src/lib/monaco-diff-provider.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'native-services',setup(b){
  b.onResolve({filter:/monaco-editor\/editor\/(?:standalone\/browser\/standaloneServices|browser\/widget\/diffEditor\/diffProviderFactoryService)\.js$/},args=>({path:args.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('/standaloneServices.js')?'export const StandaloneServices={get(){return globalThis.diffTestFactory}}':'export const IDiffProviderFactoryService=Symbol("factory")'}));
}}]});
const {createResilientDiffProvider,bindDiffRecovery} = await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const options={ignoreTrimWhitespace:false,maxComputationTimeMs:5000,computeMoves:false};
const model=text=>({text,disposed:false,isDisposed(){return this.disposed},getLinesContent(){assert.equal(this.disposed,false);return this.text.split('\n')}});
const token=()=>({isCancellationRequested:false});
const cancelled=error=>error.name==='Canceled';

test('missing native worker model recovers a real diff with Monaco ranges, not an empty success',async()=>{
  const errors=[],before=model('const value = 1;\nkeep();'),after=model('const value = 2;\nkeep();');
  const p=createResilientDiffProvider(error=>errors.push(error),async()=>null);
  const result=await p.computeDiff(before,after,options,token());
  assert.equal(result.identical,false);assert.equal(result.changes.length,1);assert.equal(result.changes[0].original.startLineNumber,1);
  assert.equal(typeof result.changes[0].modified.toInclusiveRange,'function');assert.deepEqual(errors,['']);
  assert.equal(before.text,'const value = 1;\nkeep();');assert.equal(after.text,'const value = 2;\nkeep();');
});
test('fallback uses the request snapshot when editing continues during a failed worker request',async()=>{
  let settle;const before=model('old'),after=model('new');
  const p=createResilientDiffProvider(()=>{},()=>new Promise(resolve=>{settle=resolve}));
  const pending=p.computeDiff(before,after,options,token());after.text='old';settle(null);
  const result=await pending;assert.equal(result.identical,false);assert.equal(result.changes.length,1);assert.equal(after.text,'old');
});
test('closed or cancelled editors discard pending computations without touching disposed models',async()=>{
  for(const change of ['dispose','cancel','model']){
    let settle;const before=model('a'),after=model('b'),signal=token(),errors=[];
    const p=createResilientDiffProvider(error=>errors.push(error),()=>new Promise(resolve=>{settle=resolve}));
    const pending=p.computeDiff(before,after,options,signal);
    if(change==='dispose')p.dispose();else if(change==='cancel')signal.isCancellationRequested=true;else before.disposed=true;
    settle(null);await assert.rejects(pending,cancelled);assert.deepEqual(errors,[]);
  }
});
test('native factory actually installs recovery and keeps each file error scope and disposal',async()=>{
  let nativeDisposed=0,creates=0;
  const backing={createDiffProvider(){creates++;return{computeDiff:async()=>{throw new Error('no diff result available')},onDidChange(){return{dispose(){}}},dispose(){nativeDisposed++}}}};
  // Mirror Monaco's delayed-service proxy, which caches reads but sends writes
  // to the backing instance. An ordinary method assignment does not install.
  globalThis.diffTestFactory=new Proxy(Object.create(null),{
    get(target,key){if(key in target)return target[key];const value=backing[key];if(typeof value==='function')return target[key]=value.bind(backing);return value},
    set(_target,key,value){backing[key]=value;return true}
  });
  const before=model('a'),after=model('b'),errors=[];
  const binding=bindDiffRecovery(before,error=>errors.push(error));
  const sameFactory=globalThis.diffTestFactory.createDiffProvider;const other=bindDiffRecovery(model('other'),()=>{});
  assert.equal(sameFactory,globalThis.diffTestFactory.createDiffProvider,'install once across editor mounts');
  const provider=globalThis.diffTestFactory.createDiffProvider({diffAlgorithm:'advanced'});
  assert.equal((await provider.computeDiff(before,after,options,token())).changes.length,1);assert.deepEqual(errors,['']);
  binding.dispose();other.dispose();provider.dispose();assert.equal(nativeDisposed,1);assert.equal(creates,1);
  delete globalThis.diffTestFactory;
});
