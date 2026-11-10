// Deterministic OpenCode v1 HTTP/SSE wire fixture. No model or credentials.
import http from 'node:http';

if (process.argv.includes('fixture-cli')) {
  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_cli', part: { id: 'prt_cli', text: 'cli prefix' } }));
  setInterval(() => {}, 1000);
} else {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const sessions = new Map();
  const history = new Map();
  const streams = new Set();
  const questions = new Map(), permissions = new Map();
  let heldEvents = '';
  const state = { pid: process.pid, streamOpens: 0, posts: [], aborts: [], replies: [], deletes: 0, abortFailure: false, unsafePty: false, unknownStatus: false };
  const statuses = {};
  let nextSession = 0;
  function record(frame) {
    const e = frame.payload ?? frame;
    const p = e.properties ?? {};
    if (e.type === 'session.created') sessions.set(p.info.id, p.info);
    if (e.type === 'message.updated') {
      const messages = history.get(p.info.sessionID) ?? new Map();
      const entry = messages.get(p.info.id) ?? { parts: new Map() };
      entry.info = p.info;
      messages.set(p.info.id, entry);
      history.set(p.info.sessionID, messages);
    }
    if (e.type === 'message.part.updated') {
      const messages = history.get(p.part.sessionID) ?? new Map();
      const entry = messages.get(p.part.messageID) ?? { info: { id: p.part.messageID, sessionID: p.part.sessionID, role: 'assistant' }, parts: new Map() };
      entry.parts.set(p.part.id, p.part);
      messages.set(p.part.messageID, entry);
      history.set(p.part.sessionID, messages);
    }
    if (e.type === 'session.status') statuses[p.sessionID] = p.status;
    if (e.type === 'question.asked') questions.set(p.id,p);
    if (e.type === 'permission.asked') permissions.set(p.id,p);
    if (['question.replied','question.rejected'].includes(e.type)) questions.delete(p.requestID ?? p.id);
    if (e.type === 'permission.replied') permissions.delete(p.requestID ?? p.id);
  }
  function emit(frames) {
    for (const frame of frames) record(frame);
    const bytes = frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('');
    if (state.holdEvents) heldEvents += bytes;
    else for (const stream of streams) stream.write(bytes);
  }
  function json(res, value, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : null;
    if (req.method === 'DELETE') state.deletes++;
    if (path === '/session/status') return json(res, state.unknownStatus ? null : statuses);
    if (path === '/question') return json(res,[...questions.values()]);
    if (path === '/permission') return json(res,[...permissions.values()]);
    if (path === '/pty') return json(res, state.unsafePty ? [{ id: 'pty_native', status: 'running' }] : []);
    if (path === '/event') {
      state.streamOpens++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"type":"server.connected","properties":{}}\r\n\r\n');
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (path === '/session' && req.method === 'POST') {
      const info = { id: `ses_fixture_${++nextSession}`, title: body?.title };
      sessions.set(info.id, info);
      return json(res, info);
    }
    if (path === '/fixture/state') return json(res, { ...state, streamClients: streams.size });
    if (path === '/fixture/config') { Object.assign(state, body); return json(res, true); }
    if (path === '/fixture/emit') { emit(body); return json(res, true); }
    if (path === '/fixture/raw') {
      for (const stream of streams) stream.write(Buffer.from(body.base64, 'base64'));
      if (body.flush) { state.holdEvents = false; for (const stream of streams) stream.write(heldEvents); heldEvents = ''; }
      return json(res, true);
    }
    if (path === '/fixture/close-events') { for (const stream of streams) stream.end(); return json(res, true); }
    if (path === '/fixture/exit') { json(res, true); setTimeout(() => process.exit(0), 10); return; }
    const session = path.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
    if (session) {
      const [, id, action] = session;
      if (!action) return json(res, sessions.get(id) ?? { id });
      if (action === 'message' && req.method === 'GET') {
        return json(res, [...(history.get(id)?.values() ?? [])].map(entry => ({ info: entry.info, parts: [...entry.parts.values()] })));
      }
      if (action === 'prompt_async') {
        state.posts.push({ session: id, body });
        if (body.parts[0].text === 'http-fail') return json(res, { error: 'fixture rejected prompt' }, 400);
        emit([{ type: 'message.updated', properties: { info: { id: body.messageID, sessionID: id, role: 'user' } } },
          { type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } }]);
        res.writeHead(204); res.end(); return;
      }
      if (action === 'summarize') {
        state.posts.push({ session: id, compact: true, body });
        emit([{ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } }]);
        setTimeout(() => { emit([{ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } }]); json(res, true); }, 50);
        return;
      }
      if (action === 'abort') {
        state.aborts.push(id);
        if (state.abortFailure) return json(res, { error: 'native abort failed' }, 503);
        for (const requests of [questions,permissions]) for (const [key,request] of requests) if (request.sessionID===id) requests.delete(key);
        emit([{ type: 'session.status', properties: { sessionID: id, status: { type: 'idle' } } }]);
        return json(res, true);
      }
    }
    if (/^\/(question|permission)\/[^/]+\/(reply|reject)$/.test(path)) {
      state.replies.push({ path, body });
      const [_,category,id]=path.split('/');(category==='question'?questions:permissions).delete(id);
      return json(res, true);
    }
    json(res, { error: `No fixture route: ${req.method} ${path}` }, 404);
  });
  const delay = Number(process.env.NAUTILO_FIXTURE_START_DELAY ?? 0);
  setTimeout(() => server.listen(port, '127.0.0.1'), delay);
}
