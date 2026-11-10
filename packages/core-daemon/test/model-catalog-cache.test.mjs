import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { AdapterRegistry } from '../dist/adapters/registry.js';
import { ModelCatalogCache } from '../dist/adapters/model-catalog-cache.js';
import { discoverKimiModels } from '../dist/adapters/kimi/models.js';
const instance={id:'a',providerId:'fake',executable:'fake',baseArgs:[],providerOptions:{baseUrl:'http://localhost'},models:[]};
const catalog=()=>({providerId:'fake',source:'provider_cli',fetchedAt:new Date().toISOString(),defaultModel:'m',models:[{id:'m',contextWindow:100000}]});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('cache merges concurrent discovery, clones results, expires TTL and supports explicit refresh',async()=>{
 let now=0,calls=0;const cache=new ModelCatalogCache(30,()=>now);
 const load=async()=>{calls++;await delay(5);return catalog();};
 const [a,b]=await Promise.all([cache.get('key',load),cache.get('key',load)]);
 assert.equal(calls,1);a.models[0].contextWindow=1;assert.equal(b.models[0].contextWindow,100000);
 await cache.get('key',load);assert.equal(calls,1);
 now=31;await cache.get('key',load);assert.equal(calls,2);
 await cache.get('key',load,true);assert.equal(calls,3);
});

test('errors, warnings, empty catalogs and timeouts do not poison cache or in-flight state',async()=>{
 const cache=new ModelCatalogCache(100,Date.now,20);let calls=0;
 const fail=async()=>{calls++;throw Error('fail');};
 await assert.rejects(cache.get('error',fail));await assert.rejects(cache.get('error',fail));assert.equal(calls,2);
 for(const value of [{...catalog(),warning:'fallback'},{...catalog(),models:[]},{...catalog(),source:'unavailable'}]){
  calls=0;const load=async()=>{calls++;return value;};await cache.get('negative',load);await cache.get('negative',load);assert.equal(calls,2);
 }
 await assert.rejects(cache.get('timeout',()=>new Promise(()=>{})),/timed out/);
 assert.equal((await cache.get('timeout',async()=>catalog())).models.length,1);
});

test('invalidating during discovery prevents old completion from overwriting a new adapter catalog',async()=>{
 const cache=new ModelCatalogCache();let finish;
 const old=cache.get('key',()=>new Promise(resolve=>{finish=resolve;}));await delay(0);
 cache.clear();const newer={...catalog(),defaultModel:'new'};await cache.get('key',async()=>newer);
 finish(catalog());await old;
 assert.equal((await cache.get('key',async()=>{throw Error('should hit new cache');})).defaultModel,'new');
});

test('registry isolates instance/config/context/environment and invalidates adapter registration',async(t)=>{
 let calls=0;const adapter={providerId:'fake',listModels:async()=>{calls++;return catalog();}};
 const registry=new AdapterRegistry([adapter]);
 await Promise.all([registry.listModels(instance,{env:{A:'1',B:'2'}}),registry.listModels(instance,{env:{B:'2',A:'1'}})]);assert.equal(calls,1);
 await registry.listModels({...instance,id:'other'},{env:{A:'1',B:'2'}});assert.equal(calls,2);
 await registry.listModels({...instance,providerOptions:{baseUrl:'http://other'}},{env:{A:'1',B:'2'}});assert.equal(calls,3);
 await registry.listModels(instance,{env:{A:'changed',B:'2'}});assert.equal(calls,4);
 await registry.listModels({...instance,models:[{id:'configured',contextWindow:500}]},{env:{A:'1',B:'2'}});assert.equal(calls,5);
 const key='NAUTILO_CACHE_TEST_ENV';const prior=process.env[key];t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});
 process.env[key]='one';await registry.listModels(instance);process.env[key]='two';await registry.listModels(instance);assert.equal(calls,7);
 registry.register({...adapter});await registry.listModels(instance);assert.equal(calls,8);
 registry.unregister('fake');assert.throws(()=>registry.listModels(instance),/不可用/);
});

test('run context metadata budget returns early while discovery warms the next request',async()=>{
 let calls=0,finish;const registry=new AdapterRegistry([{providerId:'fake',listModels:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}}]);
 const begin=performance.now();const result=await registry.listModelsForRun(instance,20);
 assert.equal(result,undefined);assert.ok(performance.now()-begin<200);assert.equal(calls,1);
 finish(catalog());await delay(0);
 assert.equal((await registry.listModelsForRun(instance,20)).defaultModel,'m');assert.equal(calls,1);
});

test('Kimi JSON default avoids a second CLI, empty defaults retain text fallback',async()=>{
 for(const value of ['m','',undefined]){
  const captures=[];
  const owner={invocation:(_,args)=>({command:'fake',args}),capture:async(_,args)=>{
   captures.push(args);return {exitCode:0,text:args.includes('--json')?JSON.stringify({defaultModel:value,models:{m:{maxContextSize:1000}}}):'Default model: m\n'};
  }};
  const result=await discoverKimiModels(owner,instance);assert.equal(result.defaultModel,'m');assert.equal(captures.length,value==='m'?1:2);
 }
});

test('run starts after optional metadata budget without changing model or permission settings',async()=>{
 const { Database, EventService, RunService }=await import('../dist/index.js');
 let finishDiscovery,calls=0;const requests=[];
 const adapter={providerId:'fake',descriptor:{contextWindowDiscovery:true},capabilities:{nativeResume:false},
  listModels:()=>{calls++;return new Promise(resolve=>{finishDiscovery=resolve;});},
  start:request=>{requests.push(request);async function* events(){yield {kind:'exit',exitCode:0};}return {events:events(),cancel:async()=>{},write:()=>{}};}
 };
 const db=new Database(':memory:');
 try{
  const now=new Date().toISOString();const project={id:'p',name:'P',rootPath:process.cwd(),repositoryType:'git',frontendPaths:[],backendPaths:[],ignoredPaths:[],policyId:'default'};
  const session={id:'s',projectId:'p',memberId:'a',title:'S',model:'m',reasoningEffort:'high',permissionMode:'ask',status:'idle',unreadCount:0,createdAt:now,updatedAt:now};
  db.projects.save(project,now);db.sessions.save(session);
  const registry=new AdapterRegistry([adapter]);const service=new RunService(db,registry,new EventService(db));
  const started=performance.now();const first=await service.launch(session,instance,'hello');await first.completion;
  assert.ok(performance.now()-started<650);assert.equal(requests[0].contextWindow,undefined);
  assert.equal(requests[0].model,'m');assert.equal(requests[0].permissionMode,'ask');assert.equal(requests[0].reasoningEffort,'high');
  finishDiscovery(catalog());await delay(0);
  const second=await service.launch(db.sessions.get('s'),instance,'again');await second.completion;
  assert.equal(requests[1].contextWindow,100000);assert.equal(calls,1);
 }finally{if(finishDiscovery)finishDiscovery(catalog());db.close();}
});

test('registry snapshots mutable request configuration and stores only opaque cache keys',async()=>{
 let calls=0;const adapter={providerId:'fake',listModels:async(config,context)=>{
  calls++;await delay(0);return {...catalog(),defaultModel:config.providerOptions.baseUrl+context.env.TOKEN};
 }};
 const registry=new AdapterRegistry([adapter]);
 const config=structuredClone(instance);const context={env:{TOKEN:'test-secret'}};
 const first=registry.listModels(config,context);config.providerOptions.baseUrl='changed';context.env.TOKEN='other';
 assert.equal((await first).defaultModel,'http://localhosttest-secret');
 await registry.listModels(instance,{env:{TOKEN:'test-secret'}});assert.equal(calls,1);
 await registry.listModels(instance,{env:{TOKEN:'test-secret'}},true);assert.equal(calls,2);
 for(const key of registry.modelCatalogs.ready.keys()) assert.match(key,/^[a-f0-9]{64}$/);
});
