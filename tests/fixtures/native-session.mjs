// Deterministic native protocol peer. No upstream account or network is used.
import { createInterface } from 'node:readline';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const provider = process.argv[2];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const batch = values => process.stdout.write(values.map(value=>JSON.stringify(value)+'\n').join(''));
let turns = 0;
let selected = { provider: 'test', id: 'test-model' };
let thinkingLevel = 'high';
if (provider === 'omp') emit({ type: 'ready', protocolVersion: 2 });
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if(frame.type==='extension_ui_response') {
    if(frame.id==='idle-confirm')emit({type:'extension_ui_request',method:'notify',message:frame.confirmed?'background-confirmed':'background-denied',notifyType:'info'});
    continue;
  }
  if (frame.type === 'control_request') continue;
  if (provider === 'kimi') {
    const update = value => ({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:value}});
    if (frame.id === 'idle-permission' && frame.result) {
      emit(update({sessionUpdate:'tool_call_update',toolCallId:'late-read',status:'completed',rawOutput:frame.result.outcome?.optionId==='once'?'approved-late-result':'denied'}));
      continue;
    }
    const result = frame.method === 'initialize' ? { protocolVersion: 1 }
      : frame.method === 'session/new' || frame.method === 'session/resume' ? { sessionId: 'fixture-session', configOptions: [] } : {};
    if (frame.method === 'session/prompt') {
      const text = frame.params.prompt.map(block => block.text ?? '').join('');
      if (text === 'hang') continue;
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${process.pid}:${++turns}:${text}` }
      } } });
      if (text === 'background') {
        batch([{jsonrpc:'2.0',id:frame.id,result}, update({sessionUpdate:'tool_call',toolCallId:'late-read',title:'Read late file',status:'in_progress',rawInput:{path:'background.txt'}})]);
        setTimeout(()=>batch([
          {jsonrpc:'2.0',id:'idle-permission',method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'late-read',title:'Read late file'},options:[{optionId:'once',name:'Allow once',kind:'allow_once'}]}},
          update({sessionUpdate:'tool_call',toolCallId:'parallel-tool',title:'Parallel update',status:'completed',rawOutput:'while-approval-is-pending'}),
          {jsonrpc:'2.0',method:'session/update',params:{sessionId:'other-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'cross-session-leak'}}}}
        ]),35);
        continue;
      }
      if (text === 'background-wire') {
        emit(update({sessionUpdate:'tool_call',toolCallId:'agent-background',title:'Agent',status:'in_progress',rawInput:{prompt:'late-child-prompt'}}));
        setTimeout(async()=>{
          const directory=join(process.env.KIMI_CODE_HOME,'sessions','fixture','fixture-session','agents','late-child');
          await mkdir(directory,{recursive:true});
          await appendFile(join(directory,'wire.jsonl'),JSON.stringify({type:'context.append_loop_event',event:{type:'content.part',part:{type:'text',text:'native-child-from-wire-after-turn'}}})+'\n');
        },60);
      }
    }
    if ('id' in frame) emit({ jsonrpc: '2.0', id: frame.id, result });
    continue;
  }
  if (frame.type === 'get_state') emit({ type: 'response', id: frame.id, success: true, data: { sessionId: 'fixture-session', model: selected, thinkingLevel, isStreaming:false, isCompacting:false } });
  else if (frame.type === 'set_model') { selected = { provider: frame.provider, id: frame.modelId }; emit({ type: 'response', id: frame.id, success: true }); }
  else if (frame.type === 'set_thinking_level') { thinkingLevel = frame.level; emit({ type: 'response', id: frame.id, success: true }); }
  else if (frame.type === 'prompt' || frame.type === 'user') {
    const text = frame.type === 'user' ? frame.message.content.map(block => block.text ?? '').join('') : frame.message;
    if (text === 'hang') continue;
    if (text === 'crash') process.exit(9);
    if (text === '/native-status' && ['omp','pi'].includes(provider)) {
      if (provider==='omp') emit({ type: 'command_output', text: 'native-command-output' });
      else emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'native-command-output'}]}});
      emit({ type: 'response', id: frame.id, success: true, data: provider==='omp'?{ agentInvoked: false }:{} });
      // Later command completion must never terminate the following turn.
      if(provider==='omp') setTimeout(() => emit({ type: 'prompt_result', id: frame.id, agentInvoked: false }), 30);
      continue;
    }
    const result = `${process.pid}:${++turns}:${text}`;
    if (provider === 'claude') {
      emit({ type: 'system', subtype: 'init', session_id: 'fixture-session' });
      emit({ type: 'assistant', message: { id: `reply-${turns}`, role: 'assistant', content: [{ type: 'text', text: result }] } });
      const finished={ type: 'result', subtype: 'success', session_id: 'fixture-session', is_error: false, result };
      if(text==='background') {
        batch([finished,{type:'assistant',parent_tool_use_id:'background-call',message:{id:'child-result',role:'assistant',content:[{type:'text',text:'child-in-terminal-chunk'}]}}]);
        setTimeout(()=>emit({type:'assistant',parent_tool_use_id:'background-call',message:{id:'child-later',role:'assistant',content:[{type:'text',text:'child-after-turn'}]}}),35);
      } else emit(finished);
    } else {
      emit({ type: 'message_end', message: { id: `reply-${turns}`, role: 'assistant', content: [{ type: 'text', text: result }], stopReason: 'stop' } });
      const finished={ type: provider === 'pi' ? 'agent_settled' : 'agent_end', isTerminal: true };
      if(text==='background') {
        batch([finished,{type:'tool_execution_start',toolCallId:'background-call',toolName:'read',args:{path:'background.txt'}}]);
        setTimeout(()=>{
          emit({type:'tool_execution_end',toolCallId:'background-call',toolName:'read',result:{content:[{type:'text',text:'late tool result'}]},isError:false});
          emit({type:'extension_ui_request',id:'idle-confirm',method:'confirm',title:'Background extension'});
        },35);
      } else emit(finished);
    }
  } else emit({ type: 'response', id: frame.id, success: true, data: {} });
}
