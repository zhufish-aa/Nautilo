const fs=require('node:fs');
const readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let checks=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  if(process.env.CODEX_FAKE_LOG)fs.appendFileSync(process.env.CODEX_FAKE_LOG,JSON.stringify(m)+'\n');
  if(m.id==='install-confirm') {
    send({method:'item/completed',params:{threadId:'thread-elicitation',turnId:'turn-elicitation',item:{type:'agentMessage',id:'answer',text:m.result?.action==='accept'?'Connected':'Cancelled'}}});
    return send({method:'turn/completed',params:{threadId:'thread-elicitation',turn:{id:'turn-elicitation',status:'completed'}}});
  }
  if(!m.method||m.id===undefined)return;
  const result=value=>send({id:m.id,result:value});
  if(m.method==='initialize')return result({});
  if(m.method==='thread/start'||m.method==='thread/resume')return result({thread:{id:'thread-elicitation'}});
  if(m.method==='turn/start') {
    result({turn:{id:'turn-elicitation'}});
    send({method:'turn/started',params:{threadId:'thread-elicitation',turn:{id:'turn-elicitation'}}});
    return send({id:'install-confirm',method:'mcpServer/elicitation/request',params:{threadId:'thread-elicitation',turnId:'turn-elicitation',serverName:'codex_apps',mode:'form',message:'Install GitHub',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'tool_suggestion',suggest_type:'install',tool_type:'plugin',tool_id:'github@openai-curated-remote',...(process.env.CODEX_FAKE_MISSING_PLUGIN_ID?{}:{remote_plugin_id:'plugin_fixture_github'}),tool_name:'GitHub',app_connector_ids:['github']}}});
  }
  if(m.method==='plugin/read')return result({plugin:{summary:{remotePluginId:'plugin_fixture_github'}}});
  if(m.method==='plugin/install') {
    if(m.params.pluginName!=='plugin_fixture_github') return send({id:m.id,error:{code:404,message:'Plugin not found'}});
    return result({appsNeedingAuth:[{id:'github',name:'GitHub',installUrl:'https://chatgpt.com/apps/github'}]});
  }
  if(m.method==='app/installed')return result({apps:++checks===1?[]:[{id:'github',enabled:true,callable:true}]});
  send({id:m.id,error:{code:-32601,message:'Unexpected fixture method '+m.method}});
});
