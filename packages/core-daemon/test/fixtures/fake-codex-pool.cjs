const fs = require('node:fs');
const readline = require('node:readline');
let turn = 0, active, timer, backgroundTerminal = false;
const log = (value) => fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ pid: process.pid, at: Date.now(), ...value }) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const complete = () => {
  if (!active) return;
  const { threadId, turnId, prompt } = active;
  log({ done: prompt });
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', text: `done:${prompt}` } });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  active = undefined;
};
// Windows force-termination does not run SIGTERM handlers. Observe actual
// sibling liveness at spawn instead of inferring it from a graceful-stop log.
const previousPids = fs.existsSync(process.env.CODEX_FAKE_LOG)
  ? fs.readFileSync(process.env.CODEX_FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.spawned).map(row => row.pid)
  : [];
const livePids = previousPids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
log({ spawned: true, livePids: [...new Set([...livePids, process.pid])] });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const q = JSON.parse(line); log(q);
  const reply = (result) => send({ id: q.id, result });
  if (q.method === 'initialize') setTimeout(() => { log({ initialized: true }); reply({}); }, Number(process.env.INIT_DELAY || 0));
  else if (q.method === 'thread/backgroundTerminals/list') reply({data:backgroundTerminal?[{itemId:'native-job',processId:'job',command:'native-background'}]:[],nextCursor:null});
  else if (q.method === 'test/finish-background') {backgroundTerminal=false;reply({});}
  else if (q.method === 'thread/start' || q.method === 'thread/resume') reply({ thread: { id: q.params.threadId || `thread-${process.pid}` } });
  else if (q.method === 'turn/start') {
    const prompt = q.params.input[0].text;
    const threadId = q.params.threadId, turnId = `turn-${++turn}`;
    active = { threadId, turnId, prompt };
    reply({ turn: { id: turnId } });
    notify('turn/started', { threadId, turn: { id: turnId } });
    if(prompt==='background-terminal') {
      backgroundTerminal=true;
      notify('item/started',{threadId,turnId,item:{id:'native-job',type:'commandExecution',command:'native-background',status:'inProgress'}});
      notify('item/completed',{threadId,turnId,item:{id:'native-job',type:'commandExecution',command:'native-background',status:'completed',processId:'job'}});
    }
    if (prompt === 'failed-turn') {
      const error = { message: 'Selected API rejected the model', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } };
      notify('error', { threadId, turnId, error, willRetry: false });
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error } });
      active = undefined;
      return;
    }
    if (prompt === 'retry-turn') notify('error', { threadId, turnId, error: { message: 'Temporary transport failure' }, willRetry: true });
    if (prompt === 'crash') process.exit(9);
    if (prompt === 'foreign') {
      notify('item/completed', { threadId: 'foreign', item: { type: 'agentMessage', text: 'LEAK' } });
      notify('turn/completed', { threadId, turn: { id: 'stale' } });
      send({ id: 'foreign-tool', method: 'item/tool/call', params: { threadId: 'foreign', tool: 'probe' } });
    }
    if (prompt === 'tools') {
      send({ id: 'tool', method: 'item/tool/call', params: { threadId, turnId, tool: 'probe', arguments: { pid: process.pid } } });
      send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'echo test' } });
    }
    if (!prompt.includes('hang')) timer = setTimeout(complete, prompt.startsWith('slow') ? 350 : 40);
  } else if (q.method === 'turn/interrupt') {
    if (active?.prompt === 'unresponsive-hang') return;
    clearTimeout(timer); reply({}); complete();
  } else if (q.method === 'turn/steer') reply({ turnId: active?.turnId });
});
process.on('SIGTERM', () => { log({ stopped: true }); process.exit(0); });
