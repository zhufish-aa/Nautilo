// Nautilo transport only. The model implementation lives in upstream/ unchanged.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { AntigravityBridgePlugin } from './upstream/index.mjs';
import { fromChat, toChat } from './protocol.mjs';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const { value } = await iterator.next();
const config = JSON.parse(value);
if (typeof config.token !== 'string' || config.token.length < 16) throw new Error('Missing local transport capability');
const plugin = await AntigravityBridgePlugin();
const auth = config.auth ?? { type: 'api', key: 'agy' };
const native = await plugin.auth.loader(async () => auth);
const server = createServer(async (request, response) => {
  const supplied = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(config.token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return; }
  const controller = new AbortController();
  request.once('aborted', () => controller.abort());
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    if (request.url === '/models') {
      const models = await plugin.provider.models(undefined, { auth: async () => auth });
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ models })); return;
    }
    if (!['/chat/completions', '/messages'].includes(request.url)) { response.writeHead(404).end(); return; }
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('Request exceeds local transport limit'); chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')), chat = request.url === '/chat/completions';
    const result = await native.fetch('agy://local/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chat ? fromChat(input) : input), signal: controller.signal });
    const projected = chat ? toChat(result, input) : result;
    response.writeHead(projected.status, { 'Content-Type': projected.headers.get('content-type') ?? 'application/json' });
    for await (const chunk of projected.body) {
      if (!response.write(Buffer.from(chunk))) await new Promise(resolve => response.once('drain', resolve));
    }
    response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.address().port}` }) + '\n');
await iterator.next();
server.closeAllConnections(); server.close(() => process.exit(0));
setTimeout(() => process.exit(0), 2000).unref();
