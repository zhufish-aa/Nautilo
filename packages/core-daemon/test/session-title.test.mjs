import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSessionTitle } from '../dist/runtime/session-title.js';

function fixture() {
  let session = {id:'s',title:'hi',connectionId:'api',connectionRevision:3,model:'deepseek/custom'};
  const messages = [{id:'m1',sender:'user',text:'hi'}];
  const connection = {id:'api',revision:3,kind:'api',enabled:true,protocol:'responses',baseUrl:'https://selected.example/v1',models:[{id:'deepseek/custom',reasoningEfforts:['low','max']}]};
  const database = {
    sessions:{get:()=>({...session}),save:value=>{session=value},messages:()=>messages},
    runtimeConnections:{version:(id,revision)=>{assert.equal(id,'api');assert.equal(revision,3);return connection},get:()=>connection},
  };
  const credentials={environment:id=>{assert.equal(id,'connection:api:3');return {KEY:'fixture-key'}}};
  return {database,credentials,messages,get session(){return session},rename:title=>{session={...session,title}}};
}

test('a greeting upgrades to a topic title using the pinned model and endpoint, once', async t => {
  const h=fixture();
  assert.equal((await generateSessionTitle(h.database,h.credentials,'s')).title,'问候与新会话');
  h.messages.push({id:'m2',sender:'user',text:'分析女孩修改数学成绩的谜题'});
  let calls=0;
  t.mock.method(globalThis,'fetch',async (url,request)=>{
    calls++; assert.equal(url,'https://selected.example/v1/responses');
    assert.equal(request.headers.Authorization,'Bearer fixture-key');
    const body=JSON.parse(request.body);assert.equal(body.model,'deepseek/custom');
    assert.equal(body.reasoning.effort,'low');assert.match(body.input,/分析女孩修改数学成绩/);
    return Response.json({output:[{type:'message',content:[{type:'output_text',text:'数学成绩谜题分析'}]}]});
  });
  assert.equal((await generateSessionTitle(h.database,h.credentials,'s')).title,'数学成绩谜题分析');
  assert.equal((await generateSessionTitle(h.database,h.credentials,'s')).title,'数学成绩谜题分析');
  assert.equal(calls,1);
});

test('a manual rename made during generation is preserved and failed title requests stay silent', async t => {
  const h=fixture();h.messages[0].text='请修复图片显示';h.rename('请修复图片显示');
  let finish;
  t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>{finish=resolve}));
  const pending=generateSessionTitle(h.database,h.credentials,'s');
  h.rename('我的项目');finish(Response.json({output:[{type:'message',content:[{text:'图片显示修复'}]}]}));
  assert.equal((await pending).title,'我的项目');
  assert.equal(h.session.title,'我的项目');
  h.rename('请修复图片显示');
  t.mock.method(globalThis,'fetch',async()=>{throw Error('network failed')});
  assert.equal((await generateSessionTitle(h.database,h.credentials,'s')).title,'请修复图片显示');
});
