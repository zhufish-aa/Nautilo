// Deterministic stdio-only protocol fixture. No network, credentials or model.
const { createInterface } = require('node:readline');
const { appendFileSync } = require('node:fs');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (value) => process.env.CODEX_FAKE_LOG && appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\n');
let sequence = 0;
let active;
let background;
log({ event: 'spawn' });
const finish = () => {
  if (!active) return;
  clearTimeout(active.timer);
  send({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: active.turnId, delta: `done:${active.prompt}` } });
  send({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'completed' } } });
  active = undefined;
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const q = JSON.parse(line); log(q);
  if (q.id === 'background-approval' && q.result) {
    const threadId='background-child-thread',turnId='background-child-turn';
    send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'background-final',text:'Background native child result'}}});
    send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
    return;
  }
  if (q.id === 'background-tool' && q.result) {
    send({method:'item/completed',params:{threadId:'background-child-thread',turnId:'background-child-turn',item:{type:'dynamicToolCall',id:'background-tool',tool:'probe',status:'completed',success:q.result.success,contentItems:q.result.contentItems}}});return;
  }
  if (q.id === undefined || !q.method) return;
  const result = (value) => send({ id: q.id, result: value });
  if (q.method === 'initialize') return result({});
  if (q.method === 'test/crash') { result({}); setTimeout(() => process.exit(17), 0); return; }
  if (q.method === 'thread/backgroundTerminals/list') return result({data:[],nextCursor:null});
  if (q.method === 'thread/resume' && q.params.threadId === 'background-child-thread') {
    result({thread:{id:q.params.threadId,turns:[{id:'background-child-turn',status:'inProgress',items:[]}]}});
    setTimeout(()=>{
      const threadId=q.params.threadId,turnId='background-child-turn';
      send({method:'thread/started',params:{thread:{id:threadId}}});
      send({id:'background-approval',method:'item/commandExecution/requestApproval',params:{threadId,turnId,command:'echo background',availableDecisions:['accept','decline']}});
      send({id:'background-tool',method:'item/tool/call',params:{threadId,turnId,callId:'background-tool',tool:'probe',arguments:{background:true}}});
      send({method:'item/completed',params:{threadId,turnId,item:{type:'agentMessage',id:'background-progress',text:'Child while approval pending'}}});
      if(process.env.CODEX_FAKE_CANCEL_BACKGROUND_REQUEST) setTimeout(()=>send({method:'serverRequest/resolved',params:{threadId,requestId:'background-approval'}}),50);
    },55);
    return;
  }
  if (q.method === 'thread/resume' && q.params.threadId === 'native-child-thread') {
    result({ thread: { id: q.params.threadId, turns: [{ id: 'child-turn', status: 'inProgress', items: [{ type: 'agentMessage', id: 'child-before-join', text: 'Child snapshot before join' }] }] } });
    const collab = { type: 'collabAgentToolCall', id: 'wait-native', tool: 'wait', receiverThreadIds: [q.params.threadId], agentsStates: { [q.params.threadId]: { status: 'running' } }, status: 'inProgress' };
    send({ method: 'item/started', params: { threadId: active.threadId, turnId: active.turnId, item: collab } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: q.params.threadId, tokenUsage: { total: { inputTokens: 999999 } } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: q.params.threadId, turnId: 'child-turn', itemId: 'child-result', delta: 'Real native child result' } });
    send({ method: 'item/completed', params: { threadId: q.params.threadId, turnId: 'child-turn', item: { type: 'agentMessage', id: 'child-result', text: 'Real native child result' } } });
    collab.status = 'completed'; collab.agentsStates[q.params.threadId] = { status: 'completed', message: 'Real native child result' };
    send({ method: 'item/completed', params: { threadId: active.threadId, turnId: active.turnId, item: collab } });
    send({ method: 'turn/completed', params: { threadId: q.params.threadId, turn: { id: 'child-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'child-result', text: 'Real native child result' }] } } });
    return;
  }
  if (q.method === 'thread/start' || q.method === 'thread/resume') return result({ thread: { id: q.params.threadId ?? `thread-${process.pid}-${++sequence}` } });
  if (q.method === 'thread/compact/start') {
    result({}); const threadId=q.params.threadId, turnId=`compact-${++sequence}`;
    if(process.env.CODEX_FAKE_COMPACT_ERROR) {
      send({method:'error',params:{threadId,turnId,error:{message:'Compaction API rejected the request'},willRetry:false}});return;
    }
    send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
    send({method:'item/started',params:{threadId,turnId,item:{id:'compact',type:'contextCompaction'}}});
    send({method:'item/completed',params:{threadId:'foreign',turnId,item:{id:'foreign',type:'contextCompaction'}}});
    send({method:'item/completed',params:{threadId,turnId:'old',item:{id:'stale',type:'contextCompaction'}}});
    send({method:'item/completed',params:{threadId,turnId,item:{id:'compact',type:'contextCompaction'}}});return;
  }
  if (q.method === 'turn/start') {
    if (active) return send({ id: q.id, error: { code: -32000, message: 'Concurrent turn on shared stream' } });
    const prompt = q.params.input[0].text;
    active = { threadId: q.params.threadId, turnId: `turn-${++sequence}`, prompt };
    result({ turn: { id: active.turnId } });
    send({ method: 'turn/started', params: { threadId: active.threadId, turnId: active.turnId } });
    if (prompt === 'background-native') {
      background={threadId:active.threadId,turnId:active.turnId};
      const item={type:'collabAgentToolCall',id:'spawn-background',tool:'spawnAgent',receiverThreadIds:['background-child-thread'],agentsStates:{'background-child-thread':{status:'running'}},status:'completed'};
      send({method:'item/completed',params:{...background,item}});
      active.timer=setTimeout(finish,15);return;
    }
    if (prompt === 'native-child') {
      const item = { type: 'collabAgentToolCall', id: 'spawn-native', tool: 'spawnAgent', prompt: 'Read the directory', model: 'native-test-model', receiverThreadIds: ['native-child-thread'], agentsStates: { 'native-child-thread': { status: 'running' } }, status: 'completed' };
      send({ method: 'item/completed', params: { threadId: active.threadId, turnId: active.turnId, item } });
      active.timer = setTimeout(finish, 150);
      return;
    }
    if (prompt === 'failed-turn') {
      const error = { message: 'Selected API rejected the credential' };
      send({ method: 'error', params: { threadId: active.threadId, turnId: active.turnId, error, willRetry: false } });
      send({ method: 'turn/completed', params: { threadId: active.threadId, turn: { id: active.turnId, status: 'failed', error } } });
      active = undefined;
      return;
    }
    if (prompt === 'retry-turn') send({ method: 'error', params: { threadId: active.threadId, turnId: active.turnId, error: { message: 'Temporary network failure' }, willRetry: true } });
    if (prompt === 'crash') {
      active.timer = setTimeout(() => process.exit(17), 90);
      return;
    }
    if (prompt === 'foreign') {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'previous-session', turnId: 'old', delta: 'MUST NOT LEAK' } });
      send({ method: 'item/agentMessage/delta', params: { threadId: active.threadId, turnId: 'old', delta: 'MUST NOT LEAK OLD TURN' } });
      send({ id: 'stale-tool', method: 'item/tool/call', params: { threadId: active.threadId, turnId: 'old', tool: 'must_not_run', arguments: {} } });
      send({ id: 'foreign-tool', method: 'item/tool/call', params: { threadId: 'previous-session', tool: 'must_not_run', arguments: {} } });
      send({ method: 'turn/completed', params: { threadId: 'previous-session', turn: { id: 'old' } } });
    }
    if (!['hang', 'stubborn', 'no-interrupt-response', 'tool-after-interrupt', 'crash-controlled'].includes(prompt)) active.timer = setTimeout(finish, prompt === 'slow' ? 180 : 20);
    return;
  }
  if (q.method === 'turn/interrupt') {
    if (active?.prompt !== 'no-interrupt-response') result({});
    if (active?.prompt === 'tool-after-interrupt') send({ id: 'after-cancel-tool', method: 'item/tool/call', params: { threadId: active.threadId, turnId: active.turnId, tool: 'must_not_run', arguments: {} } });
    if (active?.prompt !== 'stubborn' && active?.threadId === q.params.threadId && active?.turnId === q.params.turnId) finish();
    return;
  }
  send({ id: q.id, error: { code: -32601, message: `Unexpected method ${q.method}` } });
});
