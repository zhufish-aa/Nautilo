import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreDaemon } from '../dist/index.js';
import { startCodexAppServer } from '../dist/adapters/codex/app-server-run.js';
import { shutdownCodexAppServerPools } from '../dist/adapters/codex/app-server-pool.js';
const consume = async (run) => { const events = []; for await (const event of run.events) events.push(event); return events; };

test('CoreDaemon.stop drains runs, closes active/warm/legacy Codex processes and rejects old-owner launches without affecting live or replacement daemons', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-daemon-shutdown-'));
  await writeFile(join(root, 'app-server'), await readFile(new URL('./fixtures/fake-codex-pool.cjs', import.meta.url)));
  const logPath = join(root, 'log');
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, CODEX_FAKE_LOG: logPath };
  const daemon = new CoreDaemon({ dataDir: root, databasePath: ':memory:', enableGitWorkflows: false });
  daemon.environment.build = () => env;
  const adapter = daemon.adapters.get('codex');
  const other = new CoreDaemon({ dataDir: root, databasePath: ':memory:', enableGitWorkflows: false });
  other.environment.build = () => env;
  let replacement;
  const now = new Date().toISOString();
  const project = { id: 'p', name: 'P', rootPath: root, repositoryType: 'none', nonGitDiffMode: 'off', frontendPaths: [], backendPaths: [], ignoredPaths: [], policyId: 'default' };
  const agent = { id: 'agent', providerId: 'codex', displayName: 'Codex', executable: process.execPath, baseArgs: [], capabilities: [], providerOptions: { appServerPoolSize: 1 }, enabled: true, status: 'available', createdAt: now, updatedAt: now };
  const session = { id: 'session', projectId: project.id, memberId: agent.id, agentInstanceId: agent.id, title: 'Session', status: 'idle', unreadCount: 0, createdAt: now, updatedAt: now };
  daemon.database.projects.save(project, now);
  daemon.database.sessions.save(session);
  other.database.projects.save(project, now);
  other.database.sessions.save(session);
  const direct = { instance: agent, cwd: root, prompt: 'hang', env, timeoutMs: 5000 };
  try {
    const running = await daemon.runs.launch(session, agent, 'hang');
    for (let i = 0; i < 200; i++) {
      let rows = [];
      try { rows = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse); } catch {}
      if (rows.some((row) => row.method === 'turn/start')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const otherRunning = await other.runs.launch(session, agent, 'hang');
    const queuedRun = daemon.runs.launch(session, agent, 'forbidden-runtime');
    const queuedRejected = assert.rejects(queuedRun, /stopping/);
    const queued = adapter.start({ ...direct, localSessionId: 'queued', prompt: 'forbidden-pool' });
    const queuedEvents = consume(queued);
    const legacy = adapter.start(direct);
    const warm = adapter.start({ ...direct, instance: { ...agent, id: 'warm' }, localSessionId: 'warm', prompt: 'fast' });
    await consume(warm);
    const legacyPid = legacy.process.pid, warmPid = warm.process.pid;
    const otherPid = Number(other.database.sessions.get(session.id).providerSessionId.replace("thread-", ""));
    // Hold an already accepted launch at its real async pre-launch diff check.
    // Shutdown must wait for it and recheck admission before constructing an adapter.
    let entered, releasePreparation;
    const preparing = new Promise((resolve) => { entered = resolve; });
    const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
    daemon.runs.diffCollector.isGitWorkspace = async () => { entered(); await preparationGate; return false; };
    const preparingSession = { ...session, id: 'preparing' };
    daemon.database.sessions.save(preparingSession);
    const preparingRun = daemon.runs.launch(preparingSession, agent, 'forbidden-preparing');
    await preparing;
    const stop = daemon.stop();
    assert.equal(daemon.stop(), stop, 'repeated stop waits on the same shutdown');
    releasePreparation();
    assert.throws(() => adapter.start(direct), /shut down/);
    assert.throws(() => adapter.start({ ...direct, localSessionId: 'late' }), /shut down/);
    await assert.rejects(daemon.runs.launch(session, agent, 'late'), /stopping/);
    await stop;
    await queuedRejected;
    await running.completion;
    assert.equal((await (await preparingRun).completion).run.status, 'failed');
    assert.ok((await queuedEvents).some((event) => event.kind === 'error'));
    for (const pid of [legacyPid, warmPid]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.doesNotThrow(() => process.kill(otherPid, 0), 'another daemon process remains alive');
    assert.equal(other.database.sessions.get(session.id).status, 'running', 'another live daemon retains its same-ID session');
    await other.runs.cancel(otherRunning.runId);
    await otherRunning.completion;
    replacement = new CoreDaemon({ dataDir: root, databasePath: ':memory:', enableGitWorkflows: false });
    replacement.environment.build = () => env;
    replacement.database.projects.save(project, now);
    replacement.database.sessions.save(session);
    const restarted = await replacement.runs.launch(session, agent, 'fast-restarted');
    assert.equal((await restarted.completion).finalMessage, 'done:fast-restarted');
    await assert.rejects(daemon.runs.launch(session, agent, 'forbidden-old-owner'), /stopping/);
    const rows = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter((row) => row.method === 'turn/start' && row.params.input[0].text.startsWith('forbidden')).length, 0);
    const count = rows.filter((row) => row.spawned).length;
    await other.stop();
    await replacement.stop();
    await shutdownCodexAppServerPools();
    assert.throws(() => startCodexAppServer(direct, false), /shut down/);
    assert.equal((await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse).filter((row) => row.spawned).length, count);
  } finally {
    await daemon.stop();
    await other.stop();
    await replacement?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
