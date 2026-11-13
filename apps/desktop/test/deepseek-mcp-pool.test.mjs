import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../../rust/plugins/deepseek/resources/mcp-pool.mjs';

test('native MCP pooling preserves resolved configuration and native callbacks without restarting plugins', async t => {
  const variables = {
    NAUTILO_MCP_POOL_ADDR: '127.0.0.1:12345',
    NAUTILO_MCP_POOL_TOKEN: 'fixture',
    NAUTILO_MCP_POOL_EXE: 'D:/nautilo-core.exe',
    NAUTILO_MCP_PARENT_OVERRIDES: JSON.stringify({ OPENAI_BASE_URL: null }),
    NAUTILO_MCP_SCOPE: 'account-a',
  };
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let resolve;
  const ctx = {
    loader: {
      async import() {
        return { scrubbedParentEnv: () => ({ PATH: 'native-path', OPENAI_BASE_URL: 'temporary-model-relay' }) };
      },
      entries() { assert.fail('Loading the pool must not restart native MCP clients'); },
    },
    on(event, handler) { assert.equal(event, 'internal/config'); resolve = handler; },
  };
  await apply(ctx);
  const entry = { options: { name: '@deepseek-ai/dsh-mcp-client' } };
  const config = { transport: 'stdio', command: 'node', args: ['server.mjs'], env: { SERVICE_TOKEN: 'explicit' }, toolCallTimeoutMs: 300000 };
  const original = structuredClone(config);
  const resolved = resolve.call({ entry, parent: {} }, config, () => config);
  assert.deepEqual(config, original);
  assert.equal(resolved.toolCallTimeoutMs, 300000);
  assert.equal(resolved.command, variables.NAUTILO_MCP_POOL_EXE);
  const spec = JSON.parse(resolved.env.NAUTILO_MCP_POOL_SPEC);
  assert.equal(spec.env.PATH, 'native-path');
  assert.equal(spec.env.SERVICE_TOKEN, 'explicit');
  assert.equal(spec.env.OPENAI_BASE_URL, undefined);
  assert.equal(spec.scope, 'account-a');
  assert.equal(resolve.call({ entry, parent: { fiber: { entry } } }, config, () => config), config);
  const http = { transport: 'streamable-http', url: 'https://example.test/mcp' };
  assert.equal(resolve.call({ entry, parent: {} }, http, () => http), http);
});
