/** Cross-language contract checks. Generate NAUTILO_WORKFLOW_QA_STATE with the
 * Rust engine fixture test first, then run this file with Node >=22.5.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const require=createRequire(import.meta.url);
const ajvDirectory=process.env.NAUTILO_AJV_PATH || path.join(root,"node_modules/.pnpm",fs.readdirSync(path.join(root,"node_modules/.pnpm")).find(name=>/^ajv@8\./.test(name)),"node_modules/ajv/dist/2020.js");
const Ajv=require(ajvDirectory).default;
const validate=new Ajv({allErrors:true,strictSchema:true,strictTypes:false,strictRequired:false}).compile(JSON.parse(fs.readFileSync(path.join(root,"docs/agent-workflows/schema.v1.json"),"utf8")));
const desktop=path.join(root,"apps/desktop");
const fromVite=createRequire(require.resolve("vite/package.json",{paths:[desktop]}));
const bundle=await fromVite("esbuild").build({entryPoints:[path.join(desktop,"src/renderer/src/features/workflows/workflow-model.ts")],bundle:true,write:false,format:"cjs",platform:"node"});
const module={exports:{}};
new Function("module","exports","require",bundle.outputFiles[0].text)(module,module.exports,require);
const {starterWorkflow,eventProjection}=module.exports;
const draft=starterWorkflow();assert(validate(draft.definition),JSON.stringify(validate.errors));
for(const edit of [
  graph=>{graph.schemaVersion=2;},
  graph=>{graph.nodes.find(n=>n.kind==="agent").prompt="";},
  graph=>{graph.edges[0].maxTraversals=2;},
  graph=>{graph.nodes.find(n=>n.kind==="join").exits.push({id:"other",name:"other"});},
]){const invalid=structuredClone(draft.definition);edit(invalid);assert.equal(validate(invalid),false);}
console.log("PASS workflow JSON schema accepts the editor language and rejects malformed definitions");
const stateFile=process.env.NAUTILO_WORKFLOW_QA_STATE;
assert(stateFile,"Set NAUTILO_WORKFLOW_QA_STATE to the file emitted by the Rust workflow fixture test");
const fixtures=JSON.parse(fs.readFileSync(stateFile,"utf8"));
for(const run of Object.values(fixtures)) {
  assert(validate(run.definition),JSON.stringify(validate.errors));
  for(const submission of run.events.filter(event=>event.type==="node.submitted")) {
    const before=eventProjection(run,submission.sequence-1).instances.get(submission.instanceId);
    assert.equal(before?.result,undefined,"Historical state must not expose future submissions");
    const after=eventProjection(run,submission.sequence).instances.get(submission.instanceId);
    assert.deepEqual(after.result,submission.data.result);
  }
}
assert.equal([...eventProjection(fixtures.parallel).instances.values()].filter(instance=>instance.status==="running").length,2);
assert.equal([...eventProjection(fixtures.review).instances.values()].filter(instance=>instance.status==="waiting_join").length,0);
const arrival=fixtures.review.events.find(event=>event.type==="join.progress");
assert.equal([...eventProjection(fixtures.review,arrival.sequence).instances.values()].filter(instance=>instance.status==="waiting_join").length,1);
console.log("PASS actual Rust snapshots satisfy the JSON schema and replay without future-result leakage");
assert.equal([...eventProjection(fixtures.overlappingPending).instances.values()].filter(instance=>instance.status==="waiting_join").length,2);
const lastArrival=fixtures.overlappingPending.events.filter(event=>event.type==="join.progress").at(-1);
assert.equal([...eventProjection(fixtures.overlapping,lastArrival.sequence).instances.values()].filter(instance=>instance.status==="waiting_join").length,2);
assert.equal([...eventProjection(fixtures.overlapping).instances.values()].filter(instance=>instance.status==="waiting_join").length,0);
console.log("PASS overlapping joins remain independent in both live and historical projections");
const native=structuredClone(fixtures.parallel),instance=native.instances.find(instance=>instance.nodeId==='a');
const childSequence=native.events.length+1;
native.events.push({sequence:childSequence,type:'node.native_children',instanceId:instance.id,nodeId:instance.nodeId,timestamp:native.updatedAt,message:'native child running',data:{nativeWork:{runId:'native-run',lastSequence:1,children:{child:'running'},closed:false,released:false,detached:false}}});
native.events.push({sequence:childSequence+1,type:'node.native_children_stopped',instanceId:instance.id,nodeId:instance.nodeId,timestamp:native.updatedAt+1,message:'native child stopped'});
assert.equal(eventProjection(native,childSequence+1).instances.get(instance.id).nativeWork.released,true);
assert.equal(eventProjection(native,childSequence).instances.get(instance.id).nativeWork.released,false);
assert.equal(native.events.at(-2).data.nativeWork.released,false);
console.log("PASS native child playback preserves immutable events when later cleanup is replayed");
for(const name of ["merge","commands"]) {
  const {run}=JSON.parse(fs.readFileSync(stateFile+".workspace-"+name+".json","utf8"));
  assert(validate(run.definition),JSON.stringify(validate.errors));
  const original=JSON.stringify(run.events);
  for(const event of run.events.filter(event=>event.type==="node.workspace")) {
    const before=eventProjection(run,event.sequence-1).instances.get(event.instanceId);
    if(!run.events.some(previous=>previous.type==="node.workspace"&&previous.instanceId===event.instanceId&&previous.sequence<event.sequence)) assert.equal(before?.workspace,undefined);
    assert.deepEqual(eventProjection(run,event.sequence).instances.get(event.instanceId).workspace,event.data.workspace);
  }
  for(const event of run.events.filter(event=>event.type==="node.verified"||event.type==="node.verification_approval")) {
    assert.deepEqual(eventProjection(run,event.sequence).instances.get(event.instanceId).workspace,event.data.workspace);
  }
  assert.equal(JSON.stringify(run.events),original,"Replay modified persisted acceptance evidence");
}
console.log("PASS actual workspace verification replays immutable receipts without future workspace leakage");
const legacy=JSON.parse(fs.readFileSync(stateFile+".legacy-plan.json","utf8"));
assert(validate(legacy.definition),JSON.stringify(validate.errors));
for(const event of legacy.events.filter(event=>event.type==='node.distributed')) {
  const before=eventProjection(legacy,event.sequence-1).instances.get(event.instanceId);
  assert.equal(before?.result,undefined);
  const after=eventProjection(legacy,event.sequence).instances.get(event.instanceId);
  assert.deepEqual(after?.result,event.data.result);
  assert.deepEqual(after?.branches,event.data.branches);
}
assert.equal(legacy.instances.filter(instance=>legacy.definition.nodes.find(node=>node.id===instance.nodeId)?.kind==='agent').length,3);
console.log("PASS compiled task plans preserve automatic distribution evidence in historical playback");
const adopted=JSON.parse(fs.readFileSync(stateFile+".task-plan.json","utf8"));
assert(validate(adopted.run.definition),JSON.stringify(validate.errors));
assert.equal(adopted.run.taskProjection,undefined);
assert.equal(adopted.run.workspace.context.parentWorkspace,undefined);
for(const event of adopted.run.events) assert.equal(event.data?.workspace?.project,undefined);
const adoptedNode=adopted.run.instances.find(instance=>adopted.run.definition.nodes.find(node=>node.id===instance.nodeId)?.kind==='agent');
assert.equal(adoptedNode.taskText,'Investigate write');
const taskActivation=adopted.run.events.find(event=>event.type==='node.activated'&&event.instanceId===adoptedNode.id);
assert.equal(taskActivation.data.taskText,'Investigate write');
assert.equal(eventProjection(adopted.run,taskActivation.sequence).instances.get(adoptedNode.id).taskText,'Investigate write');
const diff=adopted.artifacts.find(artifact=>artifact.id===adoptedNode.workspace.outcome.diffArtifactId);
assert(diff);assert.equal(diff.projectRunId,'team-run');assert.equal(diff.taskId,'write');
assert.equal(adopted.run.workspace.context.artifactProjectRunId,'team-run');
assert(!JSON.stringify(adopted.run).includes('fixture-secret'));
console.log("PASS adopted task graphs retain original artifact ownership without exporting private execution snapshots");
const {DatabaseSync}=await import("node:sqlite");
const {migrateDatabase}=await import(pathToFileURL(path.join(root,"packages/core-daemon/dist/database/migrations.js")).href);
const db=new DatabaseSync(":memory:");migrateDatabase(db);
for(const table of ["workflow_templates","workflow_runs","workflow_events"])assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
assert(db.prepare("PRAGMA table_info(workflow_runs)").all().some(column=>column.name==="pending_actions"));
for(const index of ["idx_runs_workflow","idx_runs_queue_key","idx_workflow_parent"])assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(index));
db.close();console.log("PASS Node counterpart can open the workflow persistence schema");
