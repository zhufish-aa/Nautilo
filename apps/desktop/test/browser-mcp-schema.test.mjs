import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('..', import.meta.url));
const { outputFiles } = await createRequire(require.resolve('vite/package.json'))('esbuild').build({
  entryPoints: [fileURLToPath(new URL('../src/main/browser-mcp.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
});
const Module = require('node:module');
const loaded = new Module(import.meta.filename);
loaded.filename = import.meta.filename;
loaded.paths = Module._nodeModulePaths(desktop);
loaded._compile(outputFiles[0].text, import.meta.filename);
const { listenBrowserMcp, browserCapabilities } = loaded.exports;

test('browser MCP advertises Gemini-compatible version schemas while preserving v1/v2 calls', async t => {
  const calls = [];
  const server = await listenBrowserMcp(() => 'test-key', async (...args) => {
    calls.push(args);
    return { type: 'text', text: JSON.stringify({ ok: true, tabId: 'tab-one', marker: 'preserved' }) };
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const token = createHmac('sha256', 'test-key').update(`nautilo-browser-v1/${port}/test-session`).digest('base64url');
  let id = 0;
  const rpc = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/test-session`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const { tools } = await rpc('tools/list', {});
  assert.deepEqual(tools.map(tool => tool.name), browserCapabilities.tools);
  assert.ok(tools.length >= 12);
  function checkEnums(schema, path) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.enum) assert.ok(schema.enum.every(value => typeof value === 'string' && value.length > 0), path);
    for (const [key, value] of Object.entries(schema)) checkEnums(value, `${path}.${key}`);
  }
  for (const tool of tools) {
    const version = tool.inputSchema.properties.contract_version;
    assert.equal(version.type, 'integer', tool.name);
    assert.equal(version.minimum, 1, tool.name);
    assert.equal(version.maximum, 2, tool.name);
    assert.equal(version.default, 1, tool.name);
    checkEnums(tool.inputSchema, tool.name);
  }
  const call = args => rpc('tools/call', { name: 'browser_state', arguments: args });
  for (const args of [{}, { contract_version: 1 }]) {
    const result = await call(args);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.tabId, 'tab-one');
    assert.equal(result.structuredContent.marker, 'preserved');
  }
  const v2 = await call({ contract_version: 2 });
  assert.equal(v2.isError, undefined);
  assert.equal(v2.structuredContent.version, 2);
  assert.equal(v2.structuredContent.tab_id, 'tab-one');
  assert.equal(v2.structuredContent.data.marker, 'preserved');
  assert.equal(calls.length, 3);
  for (const version of [0, 3, 1.5, '1', '2', false]) {
    assert.equal((await call({ contract_version: version })).isError, true, String(version));
  }
  assert.equal(calls.length, 3, 'unsupported versions never execute a browser action');
});
