// Offline ACP peer. No credentials, network inference, or user files.
import {createInterface} from 'node:readline';
let sessionId='native-fixture', turns=0, waiting;
const pending=new Map(); let nextId=100;
const options=[{id:'model',category:'model',name:'Model',type:'select',currentValue:'gemini-fixture',options:[{value:'gemini-fixture',name:'Gemini fixture'}]},
 {id:'thought',category:'thought_level',name:'Thinking',type:'select',currentValue:'low',options:[{value:'low',name:'Low'},{value:'extra',name:'Extra'}]}];
const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\n');
const result=(id,result)=>send({id,result});
const update=update=>send({method:'session/update',params:{sessionId,update}});
const call=(method,params)=>new Promise(resolve=>{const id=++nextId;pending.set(id,resolve);send({id,method,params});});
createInterface({input:process.stdin}).on('line',async line=>{
 const v=JSON.parse(line);
 if(!v.method){pending.get(v.id)?.(v.result);pending.delete(v.id);return;}
 if(v.method==='initialize'){result(v.id,{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}},authMethods:[{id:'oauth-personal'}]});return;}
 if(['session/new','session/resume','session/load'].includes(v.method)){
  if(process.env.FIXTURE_AUTH==='required'){send({id:v.id,error:{code:-32000,message:'Authentication required'}});return;}
  if(v.params.sessionId)sessionId=v.params.sessionId;
  if(v.method==='session/load')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'HISTORY MUST NOT REPLAY'}});
  result(v.id,{sessionId,configOptions:options});return;
 }
 if(v.method==='session/set_config_option'){options.find(o=>o.id===v.params.configId).currentValue=v.params.value;result(v.id,{configOptions:options});return;}
 if(v.method==='session/cancel'){if(waiting){result(waiting,{stopReason:'cancelled'});waiting=undefined;}return;}
 if(v.method==='session/close'){result(v.id,{});return;}
 if(v.method==='session/prompt'){
  ++turns;
  const prompt=v.params.prompt[0].text;
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Working'}});
  if(prompt==='wait'){waiting=v.id;return;}
  if(prompt==='interact'){
   const permit=await call('session/request_permission',{sessionId,toolCall:{toolCallId:'tool-a',title:'Read file'},options:[{optionId:'once',name:'Allow once',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]});
   update({sessionUpdate:'tool_call',toolCallId:'tool-a',title:'Read file',status:'in_progress',rawInput:{permit:permit.outcome.optionId}});
   const answer=await call('elicitation/create',{mode:'form',sessionId,message:'Pick a destination',requestedSchema:{type:'object',required:['choice'],properties:{choice:{type:'string',oneOf:[{const:'a',title:'Alpha'},{const:'b',title:'Beta'}]}}}});
   update({sessionUpdate:'tool_call_update',toolCallId:'tool-a',status:'completed',rawOutput:answer.content});
  }
  update({sessionUpdate:'usage_update',used:127,size:200000});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:`Turn ${turns}; effort=${options[1].currentValue}`}});
  // Response follows the final chunk in the same pipe read: exposes projection races.
  result(v.id,{stopReason:'end_turn'});
 }
});
