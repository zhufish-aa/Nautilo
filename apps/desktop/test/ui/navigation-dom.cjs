/** Reproducible DOM integration checks (not a real Electron/Tauri window test).
 * Install jsdom in an isolated tools folder, then:
 * NAUTILO_JSDOM_PATH=/path/to/node_modules/jsdom node apps/desktop/test/ui/navigation-dom.cjs
 * Uses the repository's installed esbuild; does not change application dependencies.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const desktop = path.resolve(__dirname, '../..');
const fromVite = createRequire(require.resolve('vite/package.json', { paths: [desktop] }));
const esbuild = fromVite('esbuild');
const { JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH || 'jsdom');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nautilo-navigation-'));
const errors = [], failures = [], passed = [];
let dom;
const recordRejection = error => errors.push(`Unhandled rejection: ${error?.message ?? error}`);
process.on("unhandledRejection", recordRejection);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const output = path.join(scratch, 'entry.js');
  await esbuild.build({ entryPoints: [path.join(__dirname, 'navigation-entry.tsx')], outfile: output, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl', '.css': 'empty', '.ttf': 'dataurl' }, nodePaths: [path.join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'test-worker-stub', setup(build) { build.onResolve({ filter: /\?worker/ }, args => ({ path: args.path, namespace: 'test-worker' })); build.onLoad({ filter: /.*/, namespace: 'test-worker' }, () => ({ contents: 'export default class Worker { postMessage() {} terminate() {} }' })); } }] });
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
  w.eval(fs.readFileSync(output, 'utf8'));
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
  await check('legacy Work sessions expose terminal and diff drawers with Escape focus return', async () => {
    await route('/work?session=s1');
    for (const label of ['原始终端', 'Diff / 产物']) {
      const trigger = d.querySelector(`button[aria-label="${label}"]`); assert(trigger, label); trigger.focus(); trigger.click(); await sleep(100);
      const region = d.querySelector('aside[role="region"]'); assert(region, `${label} region`);
      assert.equal(d.activeElement, region);
      key(region, 'Escape'); await sleep(120); assert(!d.querySelector('aside[role="region"]')); assert.equal(d.activeElement, trigger);
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
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { dom?.window.close(); process.removeListener('unhandledRejection', recordRejection); fs.rmSync(scratch, { recursive: true, force: true }); });
