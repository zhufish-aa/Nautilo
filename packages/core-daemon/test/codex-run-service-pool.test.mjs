import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdapterRegistry, Database, EventService, RunService } from '../dist/index.js';
import { CodexAdapter } from '../dist/adapters/codex/adapter.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(10); }
  throw new Error('Real CodexAdapter subprocesses did not reach the expected state');
}

test('RunService launches same-instance Codex child sessions into parallel real adapter subprocesses and cancels independently', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nautilo-codex-service-pool-'));
  await writeFile(join(root, 'app-server'), await readFile(new URL('./fixtures/fake-codex-pool.cjs', import.meta.url)));
  const logPath = join(root, 'rpc.ndjson');
  const readLog = async () => {
    try { return (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const database = new Database(':memory:');
  const timestamp = new Date().toISOString();
  const project = { id: randomUUID(), name: 'Codex integration', rootPath: root, repositoryType: 'none', nonGitDiffMode: 'off', frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: 'default' };
  const agent = { id: randomUUID(), providerId: 'codex', displayName: 'Codex', executable: process.execPath, baseArgs: [], capabilities: [], providerOptions: { appServerPoolSize: 2 }, enabled: true, status: 'available', createdAt: timestamp, updatedAt: timestamp };
  const parent = { id: randomUUID(), projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: 'Parent', status: 'idle', unreadCount: 0, createdAt: timestamp, updatedAt: timestamp };
  const children = ['left', 'right'].map((name) => ({ ...parent, id: randomUUID(), parentSessionId: parent.id, title: name, memberId: name }));
  database.projects.save(project, timestamp);
  database.sessions.save(parent);
  for (const child of children) database.sessions.save(child);
  // Only environment construction is isolated. The registry, CodexAdapter,
  // RunService, event persistence, session queue and stdio transport are real.
  const isolatedEnvironment = { build: () => ({ PATH: process.env.PATH, HOME: root, CODEX_HOME: root, CODEX_FAKE_LOG: logPath }) };
  const adapter = new CodexAdapter();
  const service = new RunService(database, new AdapterRegistry([adapter]), new EventService(database), undefined, isolatedEnvironment);
  let handles = [];
  try {
    handles = await Promise.all([
      service.launch(children[0], agent, 'hang'),
      service.launch(children[1], agent, 'slow-right')
    ]);
    await until(async () => (await readLog()).filter((row) => row.method === 'turn/start').length === 2);
    let log = await readLog();
    const starts = log.filter((row) => row.method === 'turn/start');
    assert.equal(new Set(starts.map((row) => row.pid)).size, 2, 'two real CLI processes, not fake adapter handles');
    assert.equal(log.filter((row) => row.done).length, 0, 'both turns active before either completion');
    for (const [index, child] of children.entries()) {
      assert.equal(database.sessions.get(child.id).parentSessionId, parent.id);
      assert.equal(database.sessions.get(child.id).agentInstanceId, agent.id);
      assert.equal(database.sessions.get(child.id).status, 'running');
      assert.equal(database.runs.get(handles[index].runId).agentInstanceId, agent.id);
    }
    const leftPid = starts.find((row) => row.params.input[0].text === 'hang').pid;
    const rightPid = starts.find((row) => row.params.input[0].text === 'slow-right').pid;
    await service.cancel(handles[0].runId);
    await handles[0].completion;
    assert.equal(database.runs.get(handles[0].runId).status, 'cancelled');
    assert.equal(database.sessions.get(children[1].id).status, 'running');
    const rightResult = await handles[1].completion;
    assert.equal(rightResult.run.status, 'completed');
    assert.equal(rightResult.finalMessage, 'done:slow-right');
    log = await readLog();
    assert.ok(log.some((row) => row.pid === leftPid && row.method === 'turn/interrupt' && row.id !== undefined));
    assert.ok(log.some((row) => row.pid === leftPid && row.stopped));
    assert.equal(log.some((row) => row.pid === rightPid && row.stopped), false);
    assert.equal(database.sessions.get(children[0].id).providerSessionId, `thread-${leftPid}`);
    assert.equal(database.sessions.get(children[1].id).providerSessionId, `thread-${rightPid}`);

    const resumed = await service.launch(database.sessions.get(children[1].id), agent, 'fast-resumed');
    handles.push(resumed);
    assert.equal((await resumed.completion).finalMessage, 'done:fast-resumed');
    log = await readLog();
    assert.ok(log.some((row) => row.pid === rightPid && row.method === 'thread/resume' && row.params.threadId === `thread-${rightPid}`));
    assert.equal(log.filter((row) => row.spawned).length, 2, 'RunService resume reuses the warm child process');
  } finally {
    await Promise.all(handles.map((handle) => service.cancel(handle.runId)));
    await adapter.shutdown();
    await Promise.all(handles.map((handle) => handle.completion));
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
