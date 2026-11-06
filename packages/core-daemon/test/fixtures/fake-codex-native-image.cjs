// Native image extension fixture: no network or real credentials.
const {createInterface} = require('node:readline');
const {appendFileSync} = require('node:fs');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
appendFileSync('image-account-rpc.jsonl', JSON.stringify({pid: process.pid, accountDirectory: process.env.CODEX_HOME,
  apiKeyPresent: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.AGENTHUB_API_KEY),
  baseUrlPresent: Boolean(process.env.OPENAI_BASE_URL), args: process.argv.slice(2)}) + '\n');
createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined || !request.method) return;
  appendFileSync('image-account-rpc.jsonl', JSON.stringify(request) + '\n');
  const reply = result => send({id: request.id, result});
  if (request.method === 'initialize') return reply({});
  if (request.method === 'thread/start') return reply({thread: {id: 'official-image-thread'}});
  if (request.method === 'turn/start') {
    reply({turn: {id: 'image-turn'}});
    send({method: 'turn/started', params: {threadId: 'official-image-thread', turnId: 'image-turn'}});
    if (request.params.input[0].text.includes('"prompt":"wait"')) return;
    send({method: 'item/completed', params: {threadId: 'official-image-thread', turnId: 'image-turn',
      item: {id: 'native-image', type: 'imageGeneration', status: 'completed', result: image}}});
    return send({method: 'turn/completed', params: {threadId: 'official-image-thread', turn: {id: 'image-turn', status: 'completed'}}});
  }
  if (request.method === 'turn/interrupt') {
    reply({});
    return send({method: 'turn/completed', params: {threadId: 'official-image-thread', turn: {id: 'image-turn', status: 'interrupted'}}});
  }
  send({id: request.id, error: {code: -32601, message: 'Unexpected image fixture method'}});
});
