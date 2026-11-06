import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database, CredentialService, AdapterRegistry} from '../dist/index.js';
import {ConnectionService} from '../dist/application/connection-service.js';
import {imageAccountRequest, imageGenerationExecutor} from '../dist/runtime/image-generation.js';
import {isCodexImageGenerationConfigured, executeCodexImageGeneration} from '../dist/adapters/codex/image-generation.js';

async function fixture(t, accounts = ['official']) {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-image-account-'));
  await writeFile(join(root, 'app-server'), await readFile(new URL('./fixtures/fake-codex-native-image.cjs', import.meta.url)));
  const db = new Database(':memory:');
  const credentials = new CredentialService(db, root);
  const connections = new ConnectionService(db, credentials, new AdapterRegistry());
  for (const id of accounts) {
    const directory = join(root, id); await mkdir(directory);
    await connections.upsert({connection: {id, name: id, kind: 'login', harness: 'codex', enabled: true, loginProfileDirectory: directory}});
  }
  const agent = {id: 'codex', providerId: 'codex', executable: process.execPath, baseArgs: [], models: [{id: 'third-party-model'}],
    providerOptions: {baseUrl: 'https://third-party.invalid/v1', wireApi: 'chat', runtimeConnectionId: 'text-provider'}, enabled: true};
  const session = {id: 'parent', title: 'PRIVATE CHAT HISTORY', connectionId: 'text-provider', connectionRevision: 1};
  t.after(async () => { db.close(); await rm(root, {recursive: true, force: true}); });
  return {root, db, credentials, connections, agent, session};
}

test('image_gen uses an official account subprocess and saves its native image without using the text API', async t => {
  const f = await fixture(t);
  const executor = imageGenerationExecutor(f.db, f.credentials, f.agent, f.session, f.root);
  const request = {instance: f.agent, cwd: f.root, prompt: 'chat', env: {OPENAI_API_KEY: 'wrong-text-key'}, imageGeneration: executor};
  assert.equal(isCodexImageGenerationConfigured(request), true);
  const result = await executeCodexImageGeneration(request, {prompt: 'A blue circle', filename: '../circle.jpg'});
  assert.equal(result.mimeType, 'image/png');
  assert.match(result.path, /output[\\/]imagegen[\\/]circle\.png$/);
  assert.equal((await readFile(result.path)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const logText = await readFile(join(f.root, 'image-account-rpc.jsonl'), 'utf8');
  const log = logText.trim().split('\n').map(JSON.parse);
  assert.equal(log[0].accountDirectory, join(f.root, 'official'));
  assert.equal(log[0].apiKeyPresent, false);
  assert.equal(log[0].baseUrlPresent, false);
  assert.ok(log[0].args.includes('shell_tool'));
  const start = log.find(row => row.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only');
  assert.equal(start.params.dynamicTools, undefined, 'native image execution cannot recursively delegate');
  assert.doesNotMatch(logText, /wrong-text-key|third-party-model|third-party\.invalid|PRIVATE CHAT HISTORY/);
});

test('multiple image accounts need a choice; explicit and current-account choices are isolated', async t => {
  const f = await fixture(t, ['a', 'b']);
  const request = agent => imageAccountRequest(f.db, f.credentials, agent, f.session, f.root, {prompt: 'A circle'});
  assert.throws(() => request(f.agent), /有多个 Codex/);
  const chosen = request({...f.agent, providerOptions: {...f.agent.providerOptions, imageGenerationConnectionId: 'b'}});
  assert.equal(chosen.env.CODEX_HOME, join(f.root, 'b'));
  assert.equal(chosen.imageGeneration, undefined);
  const current = imageAccountRequest(f.db, f.credentials, f.agent, {...f.session, connectionId: 'a'}, f.root, {prompt: 'A circle'});
  assert.equal(current.env.CODEX_HOME, join(f.root, 'a'));
  await f.connections.upsert({connection: {id: 'b', name: 'b', kind: 'login', harness: 'codex', enabled: false, loginProfileDirectory: join(f.root, 'b')}, expectedRevision: 1});
  assert.throws(() => request({...f.agent, providerOptions: {imageGenerationConnectionId: 'b'}}), /账号不可用/);
});

test('missing image accounts and disabled generation never fall back to third-party credentials', async t => {
  const f = await fixture(t, []);
  const executor = imageGenerationExecutor(f.db, f.credentials, f.agent, f.session, f.root);
  await assert.rejects(executor.generate({prompt: 'A circle'}), /添加 Codex 登录账号/);
  assert.equal(imageGenerationExecutor(f.db, f.credentials, {...f.agent, providerOptions: {imageGenerationConnectionId: 'off'}}, f.session, f.root), undefined);
});

test('cancelling image generation stops the independent account process', async t => {
  const f = await fixture(t);
  const executor = imageGenerationExecutor(f.db, f.credentials, f.agent, f.session, f.root);
  const generation = executor.generate({prompt: 'wait'});
  const rejection = assert.rejects(generation);
  let log;
  for (let i = 0; i < 200; i++) {
    try { log = (await readFile(join(f.root, 'image-account-rpc.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); } catch {}
    if (log?.some(row => row.method === 'turn/start')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(log?.some(row => row.method === 'turn/start'));
  executor.cancel(); await rejection;
  assert.throws(() => process.kill(log[0].pid, 0));
});
