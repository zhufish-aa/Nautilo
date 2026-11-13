import { createInterface } from 'node:readline';
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let initialization;
const reply = (id, result) => send({ id, result });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'server/discover') {
    send({ id: message.id, error: { code: -32601, message: 'Legacy fixture', data: { pid: process.pid } } });
  } else if (message.method === 'subscriptions/listen') {
    const meta = { 'io.modelcontextprotocol/subscriptionId': message.id };
    send({ method: 'notifications/subscriptions/acknowledged', params: { _meta: meta, pid: process.pid } });
    send({ method: 'notifications/tools/list_changed', params: { _meta: meta, pid: process.pid } });
  } else if (message.method === 'initialize') {
    initialization = message;
    if (message.params.capabilities.roots) send({ id: 'roots', method: 'roots/list', params: {} });
    else reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  } else if (message.id === 'roots') {
    reply(initialization.id, { protocolVersion: initialization.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }, roots: message.result.roots });
  } else if (message.method === 'tools/call') {
    if (message.params.name === 'pending') continue;
    const token = message.params._meta?.progressToken;
    setTimeout(() => {
      if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 1 } });
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, args: message.params.arguments }) }] });
    }, message.params.arguments?.delay || 0);
  } else if (message.method === 'notifications/cancelled') {
    reply(message.params.requestId, { cancelled: true });
  } else if (message.id) reply(message.id, {});
}
