import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../dist/database/index.js';
import { CredentialService } from '../dist/runtime/security/credential-service.js';
import { ConnectionService } from '../dist/application/connection-service.js';
import { IntegrationService } from '../dist/application/integration-service.js';
import { applyConnection, connectionEnvironment } from '../dist/runtime/runtime-connection.js';
import { checkNativeAccountLogin } from '../dist/runtime/account-auth.js';
import createOpenCode from '../../provider-plugin-opencode/dist/index.js';

test('native OpenCode account reuses its environment and supports a keyless free-model route', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-native-opencode-'));
  const db = new Database(':memory:');
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  const credentials = new CredentialService(db, root);
  const service = new ConnectionService(db, credentials, {});
  const input = { id: 'native-opencode', name: 'Native OpenCode', kind: 'login', enabled: true, harness: 'opencode', nativeLogin: true, models: [{ id: 'opencode/fixture-free', reasoningEfforts: [] }] };
  const account = service.upsert({ connection: input });
  assert.equal(account.hasCredential, false);
  const agent = { id: 'opencode', providerId: 'opencode', executable: 'opencode', baseArgs: [], enabled: true, providerOptions: {} };
  const native = applyConnection(account, agent);
  assert.equal(native.providerOptions.nativeLogin, true);
  assert.equal(native.providerOptions.loginProfileDirectory, undefined);
  const original = { XDG_DATA_HOME: '/native/data', OPENCODE_CONFIG_DIR: '/native/config', OPENCODE_CONFIG_CONTENT: '{"plugin":["native-plugin"],"mcp":{"native":{"enabled":true}}}' };
  assert.deepEqual(connectionEnvironment(account, native, original, credentials), original);
  await checkNativeAccountLogin(account, { instance: native });
  assert.throws(() => service.upsert({ connection: { ...input, id: 'duplicate-native' } }));
  assert.throws(() => service.upsert({ connection: { ...input, nativeLogin: false, id: 'not-native' } }));
  const outer = { ...agent, providerId: 'pi' };
  assert.throws(() => applyConnection(account, outer));
  new IntegrationService(db).setAccountRoute(account.id, true);
  const routed = applyConnection(service.get(account.id), outer);
  assert.equal(routed.providerOptions.accountGateway, true);
  assert.equal(routed.providerOptions.baseUrl, undefined);
});

test('installed OpenCode lists native free models without a saved API key', { skip: !process.env.NAUTILO_TEST_OPENCODE }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-opencode-free-catalog-'));
  const adapter = createOpenCode();
  t.after(async () => { await adapter.dispose(); await rm(root, { recursive: true, force: true }); });
  const instance = { id: 'native-free', providerId: 'opencode', executable: process.env.NAUTILO_TEST_OPENCODE, baseArgs: [], enabled: true, providerOptions: { nativeLogin: true, runtimeConnectionId: 'native-free' } };
  const env = { ...process.env, XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), OPENCODE_CONFIG_CONTENT: '{}' };
  for (const key of Object.keys(env)) if (/^(OPENCODE_(?:API_KEY|AUTH_CONTENT|CONFIG|CONFIG_DIR)|OPENAI_API_KEY|ANTHROPIC_API_KEY|NAUTILO_CONNECTION_API_KEY)$/i.test(key)) delete env[key];
  const catalog = await adapter.listModels(instance, { env });
  assert.ok(catalog.models.some(model => model.id.startsWith('opencode/') && model.pricing?.input === 0 && model.pricing?.output === 0), 'the real native catalog must include free models');
  assert.ok(catalog.models.every(model => model.id.startsWith('opencode/') || model.id.startsWith('opencode-go/')));
});

test('OpenCode accounts have separate native credentials/history while preserving native configuration and plugins', async t => {
  const root=await mkdtemp(join(tmpdir(),'nautilo-isolated-opencode-'));
  const db=new Database(':memory:');t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
  const credentials=new CredentialService(db,root),service=new ConnectionService(db,credentials,{});
  const base={name:'OpenCode',kind:'login',harness:'opencode',nativeLogin:true,enabled:true,models:[]};
  const first=service.upsert({connection:{...base,id:'first',loginProfileDirectory:join(root,'first')}});
  const second=service.upsert({connection:{...base,id:'second',loginProfileDirectory:join(root,'second')}});
  const source={id:'harness-opencode',providerId:'opencode',executable:'opencode',baseArgs:[],providerOptions:{}};
  const original={XDG_CONFIG_HOME:join(root,'native-config'),OPENCODE_CONFIG_DIR:join(root,'native-extensions'),OPENCODE_CONFIG_CONTENT:'{"plugin":["native-plugin"],"mcp":{"native":{"enabled":true}}}',XDG_DATA_HOME:'wrong-account',OPENCODE_AUTH_CONTENT:'wrong-auth',OPENCODE_API_KEY:'wrong-key'};
  for(const account of [first,second]){
    const effective=applyConnection(account,source),env=connectionEnvironment(account,effective,original,credentials);
    assert.equal(env.XDG_DATA_HOME,join(account.loginProfileDirectory,'data'));
    assert.equal(env.XDG_STATE_HOME,join(account.loginProfileDirectory,'state'));
    assert.equal(env.XDG_CONFIG_HOME,original.XDG_CONFIG_HOME);
    assert.equal(env.OPENCODE_CONFIG_DIR,original.OPENCODE_CONFIG_DIR);
    assert.equal(env.OPENCODE_CONFIG_CONTENT,original.OPENCODE_CONFIG_CONTENT);
    assert.equal(env.OPENCODE_AUTH_CONTENT,undefined);assert.equal(env.OPENCODE_API_KEY,undefined);
  }
  assert.throws(()=>service.upsert({connection:{...base,id:'bad-profile',loginProfileDirectory:'relative'}}));
});
