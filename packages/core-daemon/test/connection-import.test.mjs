import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../dist/database/index.js";
import { AdapterRegistry } from "../dist/adapters/index.js";
import { CredentialService } from "../dist/runtime/security/credential-service.js";
import { ConnectionService } from "../dist/application/connection-service.js";
import { ConnectionImportService } from "../dist/application/connection-import/service.js";
import { Documents } from "../dist/application/connection-import/documents.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "nautilo-native-import-"));
  const db = new Database(":memory:"), credentials = new CredentialService(db, dir), connections = new ConnectionService(db, credentials, new AdapterRegistry());
  t.after(() => { db.close(); rmSync(dir, {recursive:true,force:true}); });
  return {dir,db,credentials,connections,service:new ConnectionImportService(connections,credentials)};
}
function write(root,path,text) { const file=join(root,path);mkdirSync(join(file,".."),{recursive:true});writeFileSync(file,text);return file; }

test("native imports scan real formats, keep secrets in the vault and do not modify source configs", t => {
  const {dir,db,credentials,connections,service}=fixture(t);
  const codex=write(dir,".codex/config.toml","model_provider='work'\nmodel='one'\n[model_providers.work]\nbase_url='https://relay.example/v1'\nwire_api='responses'\nenv_key='FIXTURE_KEY'\n");
  const before=readFileSync(codex,"utf8");
  write(dir,".config/opencode/opencode.jsonc",'{// native comment\n"provider":{"work":{"npm":"@ai-sdk/openai","options":{"baseURL":"https://relay.example/v1","apiKey":"{env:FIXTURE_KEY}"},"models":{"two":{"name":"Two"}}},},}');
  write(dir,".dsh/.credentials.yaml","version: 1\nrefs:\n  DSH_KEY: fixture-dsh-key\nrecords:\n  oauth:\n    token: no-oauth-import\n");
  write(dir,".dsh/profiles/desktop/cordis.patch.yml","- id: llm-pi-ai\n  config:\n    providers:\n      work:\n        api: openai-completions\n        baseURL: https://dsh.example/v1\n        apiKeyEnv: DSH_KEY\n        models:\n          - id: dsh-model\n");
  const scan=service.scan(dir,{FIXTURE_KEY:"fixture-private-key"});
  assert.equal(scan.candidates.length,2);
  assert(!JSON.stringify(scan).includes("fixture-private-key"));assert(!JSON.stringify(scan).includes("fixture-dsh-key"));
  const relay=scan.candidates.find(c=>c.baseUrl.includes("relay"));
  assert.equal(relay.sources.length,2);assert.deepEqual(relay.models.map(m=>m.id).sort(),["one","two"]);
  const input={scanId:scan.scanId,candidateIds:scan.candidates.map(c=>c.id)};
  const imported=service.import(input);assert(imported.items.every(i=>i.status==="imported"));
  assert.equal(connections.list().length,2);
  const connection=imported.items[0].connection;
  assert.equal(credentials.read(`connection:${connection.id}:1`).apiKey,"fixture-private-key");
  assert(!JSON.stringify(db.credentials.get(`connection:${connection.id}:1`)).includes("fixture-private-key"));
  assert(service.import(input).items.every(i=>i.status==="existing"));
  assert.equal(readFileSync(codex,"utf8"),before);
  assert(service.scan(dir,{FIXTURE_KEY:"fixture-private-key"}).candidates.every(c=>c.existingConnectionId));
  assert.throws(()=>service.import({scanId:"expired",candidateIds:["missing"]}));
});
test("unreadable configs are isolated and OAuth/key commands are not imported", t => {
  const {dir,service}=fixture(t);
  write(dir,".codex/auth.json",JSON.stringify({tokens:{access_token:"oauth-secret"}}));
  write(dir,".config/opencode/opencode.jsonc","{don't echo me");
  write(dir,".pi/agent/models.json",JSON.stringify({providers:{helper:{baseUrl:"https://relay.example",api:"openai-responses",apiKey:"!cat secret",models:[{id:"one"}]}}}));
  const scan=service.scan(dir,{});assert.equal(scan.candidates.length,1);assert.equal(scan.candidates[0].hasCredential,false);
  assert(scan.sources.some(s=>s.error==="CONFIG_UNREADABLE"));assert(!JSON.stringify(scan).includes("oauth-secret"));assert(!JSON.stringify(scan).includes("don't echo"));
  const docs=new Documents({});for(const key of ["!command", "${MISSING}","{env:MISSING}","sk-ant-oat-fixture"])assert.equal(docs.key(key,{},join(dir,"models.json")),undefined);
  assert.equal(new Documents({DSH_KEY:"inherited-key"}).key("{env:DSH_KEY}",{DSH_KEY:"stored-key"},join(dir,"models.json")),"stored-key");
});
test("OpenCode built-in API authentication and the selected model import without a custom provider block", t => {
  const {dir,service}=fixture(t);
  write(dir,".local/share/opencode/auth.json",JSON.stringify({openai:{type:"api",key:"fixture-openai-key"},google:{type:"oauth",access:"oauth-never-import"}}));
  write(dir,".config/opencode/opencode.jsonc",'{"model":"openai/selected-model"}');
  const scan=service.scan(dir,{});
  assert.equal(scan.candidates.length,1);assert.equal(scan.candidates[0].protocol,"responses");
  assert.equal(scan.candidates[0].models[0].id,"selected-model");assert.equal(scan.candidates[0].hasCredential,true);
});
