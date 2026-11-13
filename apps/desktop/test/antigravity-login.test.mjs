import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
const module={exports:{}};
const source=await readFile(new URL('../src/main/antigravity-login.ts',import.meta.url),'utf8');
new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(createRequire(import.meta.url),module,module.exports);
const {authenticateAntigravity}=module.exports;
function peer(){const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();const calls=[];child.stdin.on('data',chunk=>calls.push(JSON.parse(chunk)));return {child,calls,send:body=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',...body})+'\n')};}
test('Google login completes only after official authenticate succeeds',async()=>{
 const f=peer();let done=false;const flow=authenticateAntigravity(f.child).then(()=>{done=true;});
 assert.equal(f.calls[0].method,'initialize');assert.equal(f.calls[0].params.clientInfo.name,'nautilo');
 f.send({id:1,result:{protocolVersion:1,authMethods:[{id:'oauth-personal'}]}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);assert.deepEqual(f.calls[1].params,{methodId:'oauth-personal'});
 f.send({id:2,result:{}});await flow;assert.equal(done,true);
});
test('an early zero exit is not a successful Google login',async()=>{
 const f=peer();const flow=authenticateAntigravity(f.child);f.child.emit('exit',0);await assert.rejects(flow,/before Google sign-in/);
});
test('authentication errors and unsupported methods are not auto-approved',async()=>{
 const f=peer();const flow=authenticateAntigravity(f.child);
 f.send({method:'session/request_permission',id:9,params:{}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.calls.at(-1).error.code,-32601);
 f.send({id:1,result:{protocolVersion:1,authMethods:[{id:'oauth-personal'}]}});
 f.send({id:2,error:{code:-32000,message:'Authentication required'}});await assert.rejects(flow,/Google sign-in failed/);
});
