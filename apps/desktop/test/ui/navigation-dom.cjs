/** Reproducible DOM integration checks (not a real Electron/Tauri window test).
 * Install jsdom in an isolated tools folder, then:
 * NAUTILO_JSDOM_PATH=/path/to/node_modules/jsdom node apps/desktop/test/ui/navigation-dom.cjs
 * Uses the repository's installed esbuild; does not change application dependencies.
 */
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '../..');
const fromVite = createRequire(require.resolve('vite/package.json', { paths: [desktop] }));
const esbuild = fromVite('esbuild');
const { JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH || 'jsdom');
const errors = [], failures = [], passed = [];
let dom;
const recordRejection = error => errors.push(`Unhandled rejection: ${error?.message ?? error}`);
process.on("unhandledRejection", recordRejection);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const bundle = await esbuild.build({ entryPoints: [path.join(__dirname, 'navigation-entry.tsx')], write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'empty', '.ttf': 'dataurl' }, nodePaths: [path.join(desktop, 'node_modules')], alias: { '@': path.join(desktop, 'src/renderer/src') }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'test-worker-stub', setup(build) { build.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'test-worker' })); build.onLoad({ filter: /.*/, namespace: 'test-worker' }, () => ({ contents: 'export default class Worker { postMessage() {} terminate() {} }' })); } }] });
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://unit.test/#/sessions?new=1', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document;
  w.matchMedia = media => ({ matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.ResizeObserver = w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.HTMLElement.prototype.scrollTo = w.HTMLElement.prototype.scrollIntoView = function () {};
  d.queryCommandSupported = () => false; d.execCommand = () => true;
  w.URL.createObjectURL = () => 'blob:unit'; w.URL.revokeObjectURL = () => {}; w.DOMMatrix = class {};
  w.eval(bundle.outputFiles[0].text);
  await sleep(250);
  const qa = w.qa, now = '2026-11-03T02:00:00Z';
  qa.projects.setState({ projects: ['p', 'q'].map(id => ({ id, name: id === 'p' ? 'Nautilo' : 'Website', rootPath: `/test/${id}`, repositoryType: 'git', workspaceMode: 'direct', scanning: false, verificationTemplates: [], addedAt: now })) });
  qa.agents.setState({ instances: [{ id: 'a', displayName: 'Codex', providerId: 'codex', executable: 'codex', baseArgs: [], envPolicyId: 'default', enabled: true, status: 'available', createdAt: now, updatedAt: now }] });
  qa.sessions.setState({ sessions: Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, title: `Task ${i}`, mode: i % 2 ? 'work' : 'code', projectId: i === 999 ? 'removed' : 'p', target: { type: 'agent', instanceId: 'a' }, status: 'idle', unreadCount: 0, createdAt: now, updatedAt: now })) });
  await sleep(200);
  const find = (text, root = d) => [...root.querySelectorAll('button,a')].find(element => element.textContent.trim() === text);
  const route = async hash => { w.location.hash = hash; await sleep(100); };
  const waitFor = async (read, label) => { for (let i = 0; i < 60; i++) { const value = read(); if (value) return value; await sleep(50); } throw new Error(`Timed out waiting for ${label}`); };
  const check = async (name, fn) => { try { await fn(); passed.push(name); console.log('PASS', name); } catch (error) { failures.push(`${name}: ${error.message}`); console.error('FAIL', name, error.message); } };
  const key = (element, value, options = {}) => element.dispatchEvent(new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }));
  await check('one workspace, grouped mixed-mode history and bounded rows', () => {
    assert.equal(d.querySelectorAll('.composer').length, 1);
    assert.equal(d.querySelectorAll('[data-session-id]').length, 61);
    assert(d.querySelector('[data-session-id="s0"]'));
    assert(d.querySelector('[data-session-id="s1"]'));
    assert(d.body.textContent.includes('未分组'));
  });
  await check('legacy and canonical deep links do not filter saved modes or remount composer', async () => {
    await route('/work?session=s0'); assert.equal(qa.sessions.getState().activeSessionId, 's0');
    const composer = d.querySelector('.composer');
    await route('/sessions?session=s1'); assert.equal(qa.sessions.getState().activeSessionId, 's1');
    assert.equal(d.querySelector('.composer'), composer);
    assert.equal(qa.sessions.getState().sessions.find(item => item.id === 's1').mode, 'work');
    assert.equal(d.querySelectorAll('.composer').length, 1);
  });
  await check('Back and Forward restore deep-link selection', async () => {
    await route('/sessions?session=s2'); await route('/sessions?session=s3');
    w.history.back(); await sleep(150); assert.equal(qa.sessions.getState().activeSessionId, 's2');
    w.history.forward(); await sleep(150); assert.equal(qa.sessions.getState().activeSessionId, 's3');
  });
  await check('project New action selects the requested project and does not persist a session', async () => {
    const count = qa.sessions.getState().sessions.length;
    d.querySelector('[aria-label="在 Website 中新建会话"]').click(); await sleep(100);
    assert.equal(w.location.hash, '#/sessions?new=1&project=q');
    assert.equal(d.querySelector('select[aria-label="选择项目"]').value, 'q');
    assert.equal(qa.sessions.getState().activeSessionId, undefined);
    assert.equal(qa.sessions.getState().sessions.length, count);
  });
  await check('a later project New action overrides a manual project choice', async () => {
    const picker = d.querySelector('select[aria-label="选择项目"]');
    picker.value = 'p'; picker.dispatchEvent(new w.Event('change', { bubbles: true })); await sleep(60);
    assert.equal(picker.value, 'p');
    d.querySelector('[aria-label="在 Nautilo 中新建会话"]').click(); await sleep(80);
    d.querySelector('[aria-label="在 Website 中新建会话"]').click(); await sleep(80);
    assert.equal(d.querySelector('select[aria-label="选择项目"]').value, 'q');
  });
  await check('new-conversation draft survives settings and legacy route' , async () => {
    qa.drafts.getState().setText('new:conversation', 'Keep this unsent draft'); await sleep(60);
    const settingsLink = await waitFor(() => d.querySelector('[data-nav="settings"]'), 'Settings link'); settingsLink.click();
    const returnButton = await waitFor(() => d.querySelector('button[aria-label="返回对话"]'), 'Back to chat button'); assert(w.location.hash.includes('/settings')); returnButton.click();
    await waitFor(() => !w.location.hash.includes('/settings') && d.querySelector('.composer textarea'), 'conversation after return');
    assert.equal(d.querySelector('.composer textarea').value, 'Keep this unsent draft');
    await route('/work?new=1'); assert.equal(d.querySelector('.composer textarea').value, 'Keep this unsent draft');
  });
  await check('session drafts are isolated and restored', async () => {
    qa.drafts.getState().setText('s0', 'Draft zero'); qa.drafts.getState().setText('s1', 'Draft one');
    await route('/sessions?session=s0'); assert.equal(d.querySelector('.composer textarea').value, 'Draft zero');
    await route('/work?session=s1'); assert.equal(d.querySelector('.composer textarea').value, 'Draft one');
    await route('/sessions?session=s0'); assert.equal(d.querySelector('.composer textarea').value, 'Draft zero');
  });
  await check('collapse removes all sidebar chrome while search shortcut and focus restoration work', async () => {
    d.querySelector('[aria-label="收起侧栏"]').click(); await sleep(80);
    assert(d.querySelector('#workspace-sidebar').hidden); assert(d.querySelector('#sidebar-expand'));
    assert.equal(w.localStorage.getItem('nautilo.sidebar.collapsed'), 'true');
    d.querySelector('#main-content').focus(); key(d.body, 'k', { ctrlKey: true }); await sleep(100);
    assert(d.querySelector('[role="dialog"]')); assert.equal(d.activeElement.tagName, 'INPUT');
    key(d.activeElement, 'Escape'); await sleep(300);
    assert.equal(d.activeElement.id, 'sidebar-expand');
    d.querySelector('#sidebar-expand').click(); await sleep(80); assert(!d.querySelector('#workspace-sidebar').hidden); assert.equal(d.activeElement.id, 'sidebar-collapse');
  });
  await check('search arrow selection opens history and keeps one composer', async () => {
    find('搜索').click(); await sleep(100); const input = d.querySelector('[role="dialog"] input');
    key(input, 'ArrowDown'); assert.notEqual(d.activeElement, input);
    d.activeElement.click(); await sleep(250);
    assert(w.location.hash.startsWith('#/sessions?session=')); assert.equal(d.querySelectorAll('.composer').length, 1);
  });
  const openWorkspace = async () => {
    const trigger = d.querySelector('button[aria-label="工作区"]');
    assert(trigger, 'workspace trigger');
    trigger.focus();
    key(trigger, 'ArrowDown');
    return waitFor(() => d.querySelector('[role="menu"][aria-label="工作区"]'), 'workspace menu');
  };
  await check('workspace groups available tools and opens legacy Work drawers with focus return', async () => {
    await route('/work?session=s1');
    for (const [shortcut, label] of [['T', '终端'], ['D', '文件更改与产物']]) {
      const menu = await openWorkspace();
      assert.equal(menu.querySelectorAll('[role="group"]').length, 2);
      assert(!menu.querySelector('[data-shortcut="B"]'), 'browser requires a bridge');
      const item = menu.querySelector(`[data-shortcut="${shortcut}"]`);
      assert(item.textContent.includes(label));
      if (shortcut === 'T') item.click(); else key(menu, shortcut.toLowerCase());
      const region = await waitFor(() => d.querySelector('aside[role="region"]:not([hidden])'), label);
      await sleep(100);
      assert.equal(d.activeElement, region);
      key(region, 'Escape'); await sleep(120); assert(!d.querySelector('aside[role="region"]:not([hidden])'));
      assert.equal(d.activeElement, d.querySelector('button[aria-label="工作区"]'));
    }
  });
  await check('goal progress, pinning and workspace shortcuts stay local to the conversation', async () => {
    const saved = qa.sessions.getState().events;
    const plan = { kind: 'tool_activity', toolName: 'update_plan', status: 'done', input: JSON.stringify({ plan: [{ step: 'A', status: 'completed' }, { step: 'B', status: 'in_progress' }] }) };
    qa.sessions.setState({ events: { ...saved, s1: [...(saved.s1 ?? []), { id: 'workspace-plan', sessionId: 's1', sequence: 99, timestamp: now, data: plan }] } });
    const menu = await openWorkspace();
    assert.match(menu.querySelector('[data-shortcut="L"]').textContent, /1\/2/);
    key(menu, 'l');
    const card = await waitFor(() => d.querySelector('section[aria-label="会话目标"]'), 'pinned goal');
    assert.match(card.textContent, /B/);
    const pin = (await openWorkspace()).querySelector('[data-shortcut="L"]');
    assert.equal(pin.getAttribute('aria-checked'), 'true');
    key(pin, 'Escape'); await sleep(80);
    assert(card.isConnected);
    card.querySelector('button[aria-label="收起会话目标"]').click(); await sleep(60);
    assert(!card.isConnected);
    const composer = d.querySelector('.composer textarea');
    composer.focus(); key(composer, 't'); assert.equal(d.activeElement, composer); assert(!d.querySelector('aside[role="region"]:not([hidden])'));
    await openWorkspace(); await route('/sessions?session=s2');
    assert(!d.querySelector('[role="menu"][aria-label="工作区"]'));
    const next = await openWorkspace(); assert(!next.querySelector('[data-shortcut="L"]'));
    key(next, 'Escape'); await sleep(80);
    qa.sessions.setState({ events: saved });
  });
  await check('detached browser and project folder keep the current terminal open', async () => {
    const windows = [], folders = [];
    const originalBridge = w.agenthub;
    await route('/sessions?session=s1');
    key(await openWorkspace(), 't');
    const terminal = await waitFor(() => d.querySelector('aside[aria-label="终端"]:not([hidden])'), 'active terminal');
    try {
      w.agenthub = { ...originalBridge, browser: {},
        window: { isMaximized: async () => false, onMaximizedChange: () => () => {} },
        panels: { onDock: () => () => {}, open: async target => { windows.push(target); return true; } },
        shell: { openPath: async path => { folders.push(path); return ''; } } };
      qa.sessions.setState(state => ({ sessions: state.sessions.map(session => session.id === 's1' ? { ...session } : session) }));
      key(await openWorkspace(), 'b');
      await waitFor(() => windows.length, 'browser window');
      assert.equal(windows[0].kind, 'browser'); assert.equal(windows[0].sessionId, 's1');
      key(await openWorkspace(), 'f');
      await waitFor(() => folders.length, 'project folder');
      assert.equal(folders[0], '/test/p');
      assert.equal(d.querySelector('aside[aria-label="终端"]:not([hidden])'), terminal);
      key(await openWorkspace(), 't'); await waitFor(() => !d.querySelector('aside[aria-label="终端"]:not([hidden])'), 'closed terminal');
    } finally {
      if (originalBridge) w.agenthub = originalBridge; else delete w.agenthub;
    }
  });
  await check('image preview traps Tab, zooms, closes and restores focus', async () => {
    const previous = d.querySelector('#main-content'); previous.focus();
    qa.lightbox.getState().open({ src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>', name: 'example.svg' }); await sleep(100);
    const dialog = d.querySelector('[role="dialog"][aria-label="example.svg"]'); assert(dialog);
    const controls = [...dialog.querySelectorAll('button:not(:disabled)')];
    controls.at(-1).focus(); key(controls.at(-1), 'Tab'); assert.equal(d.activeElement, controls[0]);
    key(controls[0], 'Tab', { shiftKey: true }); assert.equal(d.activeElement, controls.at(-1));
    dialog.querySelector('[aria-label="放大"]').click(); await sleep(50); assert(dialog.textContent.includes('125%'));
    key(dialog, 'Escape'); await sleep(220); assert.equal(qa.lightbox.getState().image, null); assert.equal(d.activeElement, previous);
  });
  await check('all management routes and ten settings deep links render without duplicate workspaces', async () => {
    for (const path of ['/projects', '/projects/p', '/teams', '/tasks', '/runs', '/agents']) {
      await route(path); assert(d.querySelector('#main-content')); assert.equal(d.querySelectorAll('.composer').length, 1);
    }
    for (const section of ['general', 'appearance', 'agents', 'accounts', 'usage', 'skills', 'plugins', 'permissions', 'notifications', 'advanced']) {
      await route(`/settings?section=${section}`);
      assert(d.querySelector('nav[aria-label="设置分类"]'), section); assert.equal(d.querySelectorAll('.composer').length, 1);
    }
  });
  await check('selected-session delete Cancel is inert, confirm removes and selects New', async () => {
    await route('/sessions?session=s0');
    d.querySelector('[data-session-id="s0"] button[title]').click(); await sleep(100);
    const dialog = d.querySelector('[role="dialog"]'); assert(dialog); find('取消', dialog).click(); await sleep(250);
    assert(qa.sessions.getState().sessions.some(item => item.id === 's0'));
    d.querySelector('[data-session-id="s0"] button[title]').click(); await sleep(100);
    const buttons = [...d.querySelectorAll('[role="dialog"] button')];
    const confirm = buttons.find(button => /删除/.test(button.textContent) && !/取消/.test(button.textContent)); assert(confirm); confirm.click(); await sleep(300);
    assert(!qa.sessions.getState().sessions.some(item => item.id === 's0'));
    assert.equal(qa.sessions.getState().activeSessionId, undefined); assert(w.location.hash.includes('new=1'));
  });
  await check('execution opens beside chat and loads the selected workflow child even with a stale session list', async () => {
    const runId = 'workflow-inspection', selected = 'child/workflow:second';
    const definition = { schemaVersion: 1, id: 'analysis', name: '证据检查', entry: 'main', inputs: {}, nodes: [
      { id: 'main', kind: 'main', exits: [{ id: 'next', name: '开始' }] },
      { id: 'analysis', name: '综合判断', kind: 'agent', role: 'Analyst', prompt: '检查证据。', exits: [{ id: 'review', name: '证据冲突' }, { id: 'done', name: '已定位' }] },
      { id: 'verify', name: '独立复核', kind: 'agent', role: 'Verifier', prompt: '复核证据。', exits: [{ id: 'done', name: '已通过' }] },
    ], edges: [{ from: ['main', 'next'], to: 'analysis' }, { from: ['analysis', 'review'], to: 'verify' },
      { from: ['analysis', 'done'], to: '$return' }, { from: ['verify', 'done'], to: '$return' }] };
    const parent = qa.sessions.getState().sessions.find(item => item.id === 's1');
    const child = { ...parent, id: selected, title: '综合判断的子会话', memberId: 'a', agentInstanceId: 'a', parentSessionId: parent.id };
    const first = { ...child, id: 'child/workflow:first', title: '综合判断的第一次会话' };
    const time = Date.parse(now);
    const evidenceJson = JSON.stringify({ summary: '原始样本 {"result":"READY"}', files: ['src/workflow.ts'] });
    const instance = (session, iteration, status) => ({ id: `analysis-${iteration}`, nodeId: 'analysis', sessionId: session.id,
      iteration, attempt: 1, status, reminders: 0, createdAt: time + iteration, updatedAt: time,
      prompt: `检查第 ${iteration} 组证据。代码证据：${evidenceJson}\n然后复核。`,
      incoming: { from: 'main', branch: 'next', result: { summary: `上游记录 ${iteration}`, evidence: ['原始样本', '执行结果：{status: "ready"}'] } } });
    const instanceRows = [instance(first, 1, 'completed'), instance(child, 2, 'running')];
    const plan = { id: 'workflow-inspection-plan', sessionId: parent.id, runId, status: 'approved', createdAt: now,
      template: { id: definition.id, name: definition.name, revision: 1 }, nodes: [
        { key: 'verify', name: '独立复核', role: 'Verifier', task: '复核证据。', assignment: { agentInstanceId: 'reviewer' } },
      ] };
    const run = { id: runId, revision: 1, sessionId: parent.id, status: 'running', projectId: parent.projectId,
      definition, createdAt: time, updatedAt: time, events: [], messages: [], instances: instanceRows };
    const requested = [];
    const agents = qa.agents.getState().instances;
    qa.agents.setState({ instances: [...agents, { ...agents[0], id: 'reviewer', providerId: 'opencode', displayName: 'OpenCode' }] });
    w.agenthub = { window: { isMaximized: async () => false, onMaximizedChange: () => () => {} }, core: { request: async ({ method, input }) => {
      if (method === 'workflow.get') { assert.equal(input.runId, runId); return w.structuredClone?.(run) ?? run; }
      if (method === 'provider.models') return { providerId: 'codex', source: 'test', fetchedAt: now, models: [] };
      if (method === 'run.list') {
        const item = instanceRows.find(row => row.sessionId === input?.sessionId);
        return item ? [{ id: `agent-run-${item.iteration}`, sessionId: item.sessionId, agentInstanceId: 'a', status: item.status,
          workflow: { runId, instanceId: item.id, attempt: 1 } }] : [];
      }
      if (method === 'session.history') {
        requested.push(input.sessionId);
        const session = input.sessionId === selected ? child : input.sessionId === first.id ? first : { ...parent, agentInstanceId: 'a', memberId: 'a' };
        return { session, items: [], reset: !input.cursor, cursor: { epoch: 'workflow-fixture', scope: `messages:session:${input.sessionId}`, revision: 0 } };
      }
      if (method === 'artifact.changes') return { cursor: { scope: `artifacts:session:${input.sessionId}`, epoch: 'workflow-fixture', revision: 0 }, reset: !input.cursor, items: [] };
      if (method === 'event.subscribe') return { subscriptionId: input.sessionId };
      if (method === 'event.wait') await sleep(80);
      if (method === 'event.replay' || method === 'event.wait') return { events: [], lastSequence: 0 };
      if (method === 'session.followUp.list') return { items: [] };
      if (method === 'health.get') return { features: {} };
      return [];
    } } };
    try {
      await route('/sessions?session=s1');
      const inspect = async iteration => {
        qa.sessions.getState()._replaceEvents(parent.id, [{ id: 'workflow-plan', sessionId: parent.id, sequence: 1,
          timestamp: now, data: { kind: 'workflow_plan', plan, runStatus: 'running' } }]);
        const parentHash = w.location.hash;
        (await waitFor(() => find('查看执行'), 'execution action')).click();
        const panel = await waitFor(() => d.querySelector('.workflow-execution-drawer [data-node-id="analysis"] .wf-node-body'), 'execution side panel');
        panel.click();
        assert.equal(w.location.hash, parentHash);
        assert(d.querySelector('section[aria-label="对话"] .composer'));
        const selector = await waitFor(() => d.querySelector('.workflow-execution-drawer select[aria-label="选择节点执行实例"]'), 'execution attempts');
        selector.value = `analysis-${iteration}`; selector.dispatchEvent(new w.Event('change', { bubbles: true }));
        const incoming = await waitFor(() => {
          const item = d.querySelector('.workflow-execution-drawer .workflow-dispatch-incoming');
          return item?.textContent.includes(`上游记录 ${iteration}`) && item;
        }, 'incoming data in workflow execution');
        assert.equal(incoming.querySelector('.workflow-dispatch-json pre').textContent, '{status: "ready"}');
        const id = instanceRows[iteration - 1].sessionId;
        assert(!qa.sessions.getState().sessions.some(item => item.id === id));
        find('打开子会话 ↗').click();
        await waitFor(() => qa.sessions.getState().activeSessionId === id && d.querySelector('.workspace-conversation-header h1')?.textContent.includes('综合判断'), 'loaded child conversation');
        assert.equal(w.location.hash, `#/sessions?session=${encodeURIComponent(id)}`);
        assert(requested.includes(id));
      };
      await inspect(2);
      const instruction = () => [...d.querySelectorAll('.conversation-message-row article')]
        .find(card => card.querySelector('h2')?.textContent === '任务说明');
      const fallback = await waitFor(instruction, 'task instructions from workflow history');
      assert.equal(fallback.querySelector('p').textContent, instanceRows[1].prompt);
      assert.equal(d.querySelector('.workflow-dispatch-card'), null);
      const taskTitle = '检查第 2 组证据';
      const objective = taskTitle + '，用实际文件验证。\n汇报结果。';
      qa.sessions.setState(state => ({
        sessions: state.sessions.map(item => item.id === selected ? { ...item, title: taskTitle } : item),
        tasks: { ...state.tasks, [selected]: [{ id: 'fixture-task', title: taskTitle, objective, status: 'completed', dependencies: [] }] }
      }));
      await waitFor(() => instruction()?.querySelector('p')?.textContent === objective, 'saved task instructions');
      assert.equal(d.querySelector('.workspace-conversation-header h1').textContent, 'Codex');
      assert.equal(d.querySelector('.session-chat-column').textContent.split(taskTitle).length - 1, 1);
      await route('/sessions?session=s1');
      await inspect(1);
      await waitFor(() => instruction()?.querySelector('p')?.textContent === instanceRows[0].prompt, 'first task after navigation');
      qa.sessions.getState()._replaceEvents(first.id, [{ id: 'mcp-receipt', sessionId: first.id, runId: 'agent-run-1', sequence: 1, timestamp: now,
        data: { kind: 'tool_activity', status: 'done', toolName: 'nautilo_runtime_agenthub_workflow_submit',
          input: JSON.stringify({ instanceId: 'analysis-1', attempt: 1, branch: '证据冲突', result: { summary: '检查通过' } }), output: JSON.stringify({ accepted: true }) } }]);
      const toggle = await waitFor(() => d.querySelector('.conversation-process-toggle'), 'process summary');
      if (toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      const step = await waitFor(() => d.querySelector('.workflow-tool-activity button:has(.workflow-tool-node)'), 'friendly workflow MCP trace');
      assert(step.querySelector('[data-provider="codex"] img'));
      assert(step.querySelector('.workflow-tool-route [data-provider="opencode"] img'));
      assert.match(step.textContent, /提交节点结果.*出口.*证据冲突.*独立复核.*已接收/);
      step.click();
      const raw = await waitFor(() => d.querySelector('.workflow-tool-raw'), 'technical details');
      assert.equal(raw.open, false);
      assert(d.querySelector('.workflow-tool-detail').textContent.includes('检查通过'));
    } finally {
      await route('/sessions?new=1');
      delete w.agenthub;
      qa.agents.setState({ instances: agents });
      await sleep(50);
    }
  });
  await check('first Send preserves selected model, permission and Plan using an in-memory bridge', async () => {
    const calls = [];
    const catalog = { providerId: 'claude', source: 'test', fetchedAt: now, models: [{ id: 'test-model', displayName: 'Test model', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', capabilities: [], serviceTiers: [] }] };
    // Attached only after startup: no daemon initialization, filesystem, CLI or external calls.
    // Sending is captured then intentionally rejected, so no real run/poll can begin.
    w.agenthub = { window: { isMaximized: async () => false, onMaximizedChange: () => () => {} }, core: { request: async request => {
      calls.push(request);
      if (request.method === 'provider.models') return catalog;
      if (request.method === 'artifact.changes') return { cursor: { scope: request.input.sessionId ? `artifacts:session:${request.input.sessionId}` : `artifacts:projectRun:${request.input.projectRunId}`, epoch: 'test-only', revision: 0 }, reset: !request.input.cursor, items: [] };
      if (request.method === 'session.history') throw Object.assign(new Error('Unknown method session.history'), { code: 'IPC_METHOD_NOT_FOUND' });
      if (request.method === 'session.get') return { session: calls.findLast(call => call.method === 'session.upsert' && call.input.id === request.input.sessionId).input, messages: [] };
      if (request.method === 'event.subscribe') return { subscriptionId: 'test-only' };
      if (request.method === 'event.replay') return { events: [], lastSequence: 0 };
      if (request.method === 'session.followUp.list') return { items: [] };
      if (request.method.endsWith('.upsert')) return request.input;
      if (request.method === 'session.send') throw new Error('Test bridge: send captured; no CLI is connected');
      if (request.method.endsWith('.list')) return [];
      throw new Error(`Test bridge does not implement ${request.method}`);
    } } };
    qa.providers.setState({ catalog: [{ providerId: 'claude', name: 'Test Claude', vendor: 'Test', capabilities: [], permissionModes: ['default', 'acceptEdits', 'plan'].map(value => ({ value, name: { 'zh-CN': value, 'en-US': value }, description: { 'zh-CN': '', 'en-US': '' } })) }] });
    qa.agents.setState({ instances: [{ ...qa.agents.getState().instances[0], providerId: 'claude', executable: 'test-cli' }], modelCatalogs: { a: catalog } });
    await route('/sessions?new=1&project=q');
    d.querySelector('.composer button[aria-label="选择模型"]').click(); await sleep(80);
    const model = [...d.querySelectorAll('button')].find(button => button.textContent.includes('Test model'));
    assert(model); model.click(); await sleep(70);
    d.querySelector('.composer button[aria-label="选择推理强度"]').click(); await sleep(50);
    const low = [...d.querySelectorAll('button')].find(button => button.textContent.trim() === 'Low'); assert(low, 'Low reasoning option'); low.click(); await sleep(50);
    assert(d.querySelector('.composer button[aria-label="选择推理强度"]').textContent.includes('Low'));
    key(d.body, 'Escape'); await sleep(50);
    const plan = find('Plan'); assert(plan); plan.click(); await sleep(70);
    assert.equal(plan.getAttribute('aria-pressed'), 'true');
    qa.drafts.getState().setText('new:conversation', 'Check the initial configuration'); await sleep(70);
    const send = d.querySelector('.composer-send'); assert(send && !send.disabled); send.click(); await sleep(250);
    const created = qa.sessions.getState().sessions.find(session => session.title === 'Check the initial configuration'); assert(created);
    assert.equal(created.projectId, 'q'); assert.equal(created.model, 'test-model'); assert.equal(created.permissionMode, 'plan');
    assert.equal(created.reasoningEffort, 'low');
    const persisted = calls.find(call => call.method === 'session.upsert' && call.input.id === created.id); assert(persisted);
    assert.equal(persisted.input.model, 'test-model'); assert.equal(persisted.input.permissionMode, 'plan'); assert.equal(persisted.input.reasoningEffort, 'low');
    const sent = calls.find(call => call.method === 'session.send'); assert(sent); assert.equal(sent.input.sessionId, created.id); assert.equal(sent.input.text, 'Check the initial configuration');
    assert.equal(d.querySelectorAll('.composer').length, 1);
    delete w.agenthub;
  });
  await check('no React DOM or unhandled runtime errors', () => assert.deepEqual(errors, []));
  console.log(JSON.stringify({ passed, failures, errors }, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { dom?.window.close(); process.removeListener('unhandledRejection', recordRejection); });
