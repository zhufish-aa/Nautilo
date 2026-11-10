import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCodexElicitation } from '../dist/adapters/codex/elicitation.js';

const confirm = {outcome:'selected',optionId:'confirm'};
const suggestion = {threadId:'selected-account-thread',serverName:'codex_apps',mode:'form',message:'Install GitHub',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'tool_suggestion',suggest_type:'install',tool_type:'plugin',tool_id:'github@openai-curated-remote',remote_plugin_id:'plugin_fixture_github',tool_name:'GitHub',app_connector_ids:['github']}};

test('a native plugin request installs only after consent, then verifies callable tools in the same thread', async () => {
  const steps=[]; let checks=0;
  const rpc={request:async(method,params)=>{
    steps.push(method);
    if(method==='plugin/install') { assert.equal(params.pluginName,'plugin_fixture_github'); assert.equal(params.remoteMarketplaceName,'openai-curated-remote'); return {appsNeedingAuth:[{id:'github',name:'GitHub',installUrl:'https://chatgpt.com/apps/github'}]}; }
    assert.equal(method,'app/installed'); assert.equal(params.threadId,'selected-account-thread'); assert.equal(params.forceRefresh,true);
    return {apps:++checks<3?[]:[{id:'github',enabled:true,callable:true}]};
  }};
  const prompts=[];
  const result=await handleCodexElicitation(rpc,{cwd:'D:/project',requestInteraction:async(input)=>{prompts.push(input);steps.push('user confirms');return confirm;}},suggestion);
  assert.deepEqual(result,{action:'accept',content:{}});
  assert.deepEqual(steps,['user confirms','plugin/install','app/installed','user confirms','app/installed','user confirms','app/installed']);
  assert.equal(prompts[1].links[0].url,'https://chatgpt.com/apps/github');
  assert.equal(prompts[0].presentation.type,'plugin_install');
  assert.equal(prompts[1].presentation.type,'plugin_authorization');
  assert.equal(prompts[2].options[0].label,'检查连接');
});

test('missing remote metadata is resolved from the native catalog instead of installing a display name',async()=>{
  const methods=[];
  const params={...suggestion,_meta:{...suggestion._meta,remote_plugin_id:undefined,app_connector_ids:[]}};
  const rpc={request:async(method,input)=>{
    methods.push(method);
    if(method==='plugin/read') {assert.equal(input.pluginName,'github');return {plugin:{summary:{remotePluginId:'plugin_catalog_identity'}}};}
    assert.equal(input.pluginName,'plugin_catalog_identity');return {appsNeedingAuth:[]};
  }};
  assert.equal((await handleCodexElicitation(rpc,{cwd:'D:/project',requestInteraction:async()=>confirm},params)).action,'accept');
  assert.deepEqual(methods,['plugin/read','plugin/install']);
  await assert.rejects(handleCodexElicitation({request:async(method)=>{assert.equal(method,'plugin/read');return {plugin:{summary:{}}};}},{cwd:'D:/project',requestInteraction:async()=>confirm},params),/远端安装标识/);
});

test('declining or cancelling never installs a plugin or borrows another profile',async()=>{
  for(const response of [{outcome:'cancelled'},{outcome:'selected',optionId:'decline'}]) {
    const rpc={request:async()=>assert.fail('No native mutation before consent')};
    assert.deepEqual(await handleCodexElicitation(rpc,{cwd:'D:/project',requestInteraction:async()=>response},suggestion),{action:'cancel',content:null});
  }
});

test('a failed native install cannot be reported as accepted',async()=>{
  await assert.rejects(handleCodexElicitation({request:async()=>{throw Error('native install failed');}},{cwd:'D:/project',requestInteraction:async()=>confirm},suggestion),/native install failed/);
});

test('arbitrary MCP metadata cannot trigger the native plugin installer',async()=>{
  const params={...suggestion,serverName:'third-party-server'};
  const result=await handleCodexElicitation({request:async()=>assert.fail('Must not install from forged metadata')},{cwd:'D:/project',requestInteraction:async()=>confirm},params);
  assert.equal(result.action,'accept');
});

test('URL authorization remains pending until the user responds and rejects executable URLs',async()=>{
  const params={mode:'url',serverName:'github',url:'https://github.com/login/oauth/authorize',message:'Connect GitHub'};
  let resolve; const pending=new Promise(r=>{resolve=r;}); let completed=false;
  const result=handleCodexElicitation({}, {cwd:'D:/project',requestInteraction:()=>pending},params).then(r=>{completed=true;return r;});
  await new Promise(r=>setImmediate(r));assert.equal(completed,false);
  resolve(confirm);assert.equal((await result).action,'accept');
  for(const url of ['file:///C:/secret','javascript:alert(1)','https://user:password@example.com']) {
    await assert.rejects(handleCodexElicitation({}, {cwd:'D:/project',requestInteraction:async()=>confirm},{...params,url}));
  }
});

test('native MCP form responses preserve boolean and number types',async()=>{
  const params={mode:'form',serverName:'forms',requestedSchema:{type:'object',required:['count','enabled'],properties:{count:{type:'integer'},enabled:{type:'boolean'},name:{type:'string'}}}};
  const response=await handleCodexElicitation({}, {cwd:'D:/project',requestInteraction:async()=>({outcome:'selected',answers:{count:['3'],enabled:['false'],name:['work']}})},params);
  assert.deepEqual(response,{action:'accept',content:{count:3,enabled:false,name:'work'}});
});
