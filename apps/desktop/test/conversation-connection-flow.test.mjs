import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require(process.env.NAUTILO_JSDOM_PATH ?? 'jsdom')); } catch {}

test('native discovery and saved connections support changing the next message without interrupting the current turn', {
  skip: !JSDOM && 'Set NAUTILO_JSDOM_PATH to an isolated jsdom installation',
}, async () => {
  const desktop = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const src = join(desktop, 'src/renderer/src').replaceAll('\\', '/');
  const esbuild = createRequire(require.resolve('vite/package.json', { paths: [desktop] }))('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'nautilo-connection-flow-'));
  const output = join(scratch, 'entry.js');
  let dom;
  try {
    const runtimeSource = await readFile(join(src, 'lib/orchestration-runtime.ts'), 'utf8');
    const runtimeNames = [...runtimeSource.matchAll(/export (?:async )?function (\w+)/g)].map(match => match[1]);
    const bundle = await esbuild.build({
      stdin: {
        resolveDir: desktop, loader: 'tsx', contents: `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {MemoryRouter} from 'react-router-dom';
          import {NewConversation} from '${src}/features/sessions/NewConversation';
          import {Composer} from '${src}/features/sessions/Composer';
          import {sendWorkbenchMessage as sendExisting} from '${src}/lib/orchestration-runtime.ts';
          import {I18nProvider} from '${src}/lib/i18n';
          import {TooltipProvider} from '${src}/components/ui/Tooltip';
          import {useAgentsStore as agents} from '${src}/stores/agents';
          import {useProjectsStore as projects} from '${src}/stores/projects';
          import {useConnectionsStore as connections} from '${src}/stores/connections';
          import {useSessionsStore as sessions} from '${src}/stores/sessions';
          import {useTeamsStore as teams} from '${src}/stores/teams';
          import {useComposerDraftsStore as drafts} from '${src}/stores/composer-drafts';
          const root=createRoot(document.getElementById('root'));
          window.qa={agents,projects,connections,sessions,teams,drafts,sent:[],created:[],configured:[],followUps:[],sendExisting,
            render:(key='draft',sessionId,running=false)=>root.render(<MemoryRouter><I18nProvider><TooltipProvider>
              {sessionId ? <Composer key={key} sessionId={sessionId} running={running}/> : <NewConversation key={key} onCreated={id=>window.qa.created.push(id)}/>}
            </TooltipProvider></I18nProvider></MemoryRouter>)};
        `,
      },
      outfile: output, write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      nodePaths: [join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'no-cli', setup(build) {
        build.onResolve({ filter: /orchestration-runtime$/ }, () => ({ path: 'runtime', namespace: 'no-cli' }));
        build.onLoad({ filter: /.*/, namespace: 'no-cli' }, () => ({ contents: runtimeNames.map(name =>
          `export async function ${name}(...args){${name === 'sendWorkbenchMessage' ? 'if (args[0]==="old") return window.qa.sendExisting(...args); window.qa.sent.push(args);' : name === 'configureWorkbenchSession' ? 'window.qa.configured.push(args);' : name === 'sendWorkbenchFollowUp' ? 'window.qa.followUps.push(args);' : ''}}`
        ).join('\n') }));
      } }],
    });
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => errors.push(error.message));
    virtualConsole.on('error', (...args) => errors.push(args.join(' ')));
    dom = new JSDOM('<div id="root"></div>', { url: 'http://unit.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
    const w = dom.window, d = w.document;
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = () => {};
    w.HTMLElement.prototype.hasPointerCapture = () => false;
    w.HTMLElement.prototype.setPointerCapture = w.HTMLElement.prototype.releasePointerCapture = () => {};
    const writes = [];
    const deliveries = [];
    const enabledRoutes = [];
    let savedExisting;
    let blockSwitch = false;
    w.agenthub = { core: { request: async ({ method, input }) => {
      if (method === 'health.get') return { features: { workflowPlans: 1, composerReferences: 1 } };
      if (method === 'capability.list') {
        assert.equal(input.sessionId, 'old');
        return [
          { id: 'native:skill:pdf', name: 'PDF', kind: 'skill', enabled: true, providerIds: ['deepseek'], updatedAt: now },
          { id: 'browser', name: 'Playwright', kind: 'mcp', enabled: true, providerIds: ['deepseek'], updatedAt: now },
          { id: 'disabled-pdf', name: 'PDF disabled', kind: 'skill', enabled: false, providerIds: ['deepseek'], updatedAt: now },
          { id: 'unrelated', name: 'Other harness', kind: 'mcp', enabled: true, providerIds: ['codex'], updatedAt: now }
        ];
      }
      if (method === 'capability.diagnose') return {
        steps: [{ id: 'initialize', state: 'passed' }], toolCount: 1, tools: [{ name: 'browser_snapshot' }]
      };
      if (method === 'workflow.templates') return Array.from({ length: 4 }, (_, index) => ({
        id: `workflow-${index}`, revision: 2, name: `已保存流程 ${index + 1}`, definition: { nodes: [{}, {}] }
      }));
      if (method === 'connection.gateway') {
        enabledRoutes.push(input);
        return { ...account, accountGateway: true };
      }
      if (method === 'session.upsert') {
        if (input.id === 'old' && input.confirmConnectionChange && blockSwitch) throw Error('The connection is temporarily unavailable');
        writes.push(input);
        const saved = input.connectionId === null ? { ...input, connectionId: undefined, connectionRevision: undefined } : input;
        if (input.id === 'old') savedExisting = saved;
        return saved;
      }
      if (method === 'session.send') {
        deliveries.push({ ...input, connectionId: savedExisting.connectionId, model: savedExisting.model });
        return { accepted: true, runId: 'completed' };
      }
      if (method === 'session.history') return { session: savedExisting, reset: true, cursor: { scope: 'messages:session:old', epoch: 'test', revision: 1 }, items: [] };
      if (method === 'artifact.changes') return { reset: true, cursor: { scope: 'artifacts:session:old', epoch: 'test', revision: 1 }, items: [] };
      if (method === 'event.subscribe') return { subscriptionId: 'test' };
      if (method === 'event.replay') return { events: [], lastSequence: 0 };
      if (method === 'event.wait') return new Promise(() => {});
      if (method === 'session.followUp.list') return { items: [] };
      if (method === 'run.list' || method === 'slashCommand.list') return [];
      if (method === 'agent.upsert' || method === 'project.upsert') return input;
      throw Error(`Unexpected IPC: ${method}`);
    } } };
    w.eval(bundle.outputFiles.find(file => file.path.endsWith('.js')).text);
    const q = w.qa;
    const settle = () => new Promise(resolve => w.setTimeout(resolve, 70));
    const now = '2026-11-03T00:00:00Z';
    const model = id => ({ id, displayName: id, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'low', capabilities: [], serviceTiers: [] });
    const saved = { id: 'deepseek', name: 'DeepSeek', kind: 'api', protocol: 'chat', enabled: true, hasCredential: true, revision: 1, models: [model('deepseek/flash')], createdAt: now, updatedAt: now };
    const account = { ...saved, id: 'account', name: 'Antigravity', kind: 'login', harness: 'antigravity', models: [model('gemini-flash')] };
    const historicalReads = [];
    q.connections.setState({ connections: [saved, account], hydrate: async () => {}, get: async (id, revision) => { historicalReads.push(revision); return { ...saved, revision }; } });
    const nativeReads = [];
    q.agents.setState({
      instances: [{ id: 'h', providerId: 'codex', configurationKind: 'harness', displayName: 'Codex', executable: 'codex', baseArgs: [], enabled: true, status: 'available' }],
      loadModels: async id => {
        nativeReads.push(id);
        const catalog = { providerId: 'codex', models: [model('native-default')], defaultModel: 'native-default', source: 'provider_cli', fetchedAt: now };
        q.agents.setState({ modelCatalogs: { [id]: catalog } });
        return catalog;
      },
    });
    q.projects.setState({ projects: [{ id: 'p', name: 'Project', rootPath: '/test', verificationTemplates: [] }] });
    q.teams.setState({ teams: [] });
    q.drafts.getState().setText('new:conversation', 'Test message');
    q.render();
    await settle(); await settle();
    assert.equal(d.querySelector('.new-conversation h1').textContent, '在 Project 开始新任务');
    const launch = [...d.querySelectorAll('.starter-launch > button')];
    assert.equal(launch.length, 3, 'the starter shows at most three saved workflows');
    assert.match(launch[0].textContent, /@ 已保存流程 1.*2 节点/);
    launch[0].click();
    await settle();
    assert.equal(q.drafts.getState().drafts['new:conversation'].workflow.id, 'workflow-0');
    assert.equal(d.querySelector('textarea').value, 'Test message');
    assert.equal(d.activeElement, d.querySelector('textarea'));
    d.querySelector('[aria-label="移除工作流引用"]').click();
    await settle();
    const send = () => d.querySelector('.composer-send');
    const menu = () => d.querySelector('.composer-model-menu');
    const openModels = async () => { const trigger = d.querySelector('.composer-model-trigger'); if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click(); await settle(); };
    const chooseSource = async (trigger, label) => {
      trigger.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await settle();
      const option = [...d.querySelectorAll('[role="option"]')].find(item => item.textContent.startsWith(label));
      assert.ok(option, `${label} is selectable`);
      option.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle(); await settle();
    };
    assert.equal(send().disabled, false, 'the native CLI is usable without a managed account');
    assert.equal(d.querySelector('.starter-context [aria-label="供应商或账号"]').textContent, '原生配置');
    assert.ok(nativeReads.includes('h'), 'native harnesses discover their own model catalog');
    await openModels();
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'native-default');
    d.querySelector('.composer-model-trigger').click();
    await settle();
    assert.equal(d.querySelector('.composer [role="status"]'), null, 'the composer does not show the removed configuration hint');
    await chooseSource(d.querySelector('[aria-label="供应商或账号"]'), 'DeepSeek');
    assert.equal(send().disabled, false, 'one saved API model makes a typed draft sendable');
    await openModels();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1);
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'deepseek/flash');

    q.connections.setState({ modelCatalogs: { 'deepseek:1': { providerId: 'connection:deepseek', models: [model('Claude Sonnet'), model('unconfigured')], defaultModel: 'Claude Sonnet', source: 'provider_api', fetchedAt: now } } });
    await settle();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1, 'a broad discovery result cannot expand configured models');
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'deepseek/flash');
    const search = menu().querySelector('input');
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    assert.equal(d.getElementById(search.getAttribute('aria-activedescendant')).textContent, 'deepseek/flash');
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    assert.equal(menu().querySelector('.model-menu-option[aria-selected="true"]').textContent, 'deepseek/flash');
    assert.equal(send().disabled, false, 'choosing a model preserves a valid provider binding');
    for (const label of ['Low', 'Medium', 'High', 'Extra High', 'Max']) {
      await openModels();
      const effort = [...menu().querySelectorAll('.model-menu-efforts button')].find(item => item.textContent === label);
      assert.ok(effort, `the configured ${label} level is selectable`);
      effort.click();
      await settle();
      assert.ok(d.querySelector('.composer-model-trigger').textContent.includes(label));
      assert.equal(send().disabled, false, `${label} must not clear the selected account`);
      assert.ok(!d.querySelector('.composer-model-trigger').textContent.includes('请先选择供应商或账号'));
    }

    // Settings save while the unsent conversation stays mounted behind that page.
    const edited = { ...saved, revision: 3, models: [model('deepseek/new-flash')] };
    q.connections.setState({ connections: [edited, account] });
    await settle(); await settle();
    assert.match(d.querySelector('.composer-model-trigger').textContent, /deepseek\/new-flash/);
    assert.equal(d.querySelector('textarea').value, 'Test message');
    assert.equal(send().disabled, false, 'new settings cannot strand the draft on its old revision');
    send().click();
    await settle();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].connectionId, 'deepseek');
    assert.equal(writes[0].connectionRevision, 3);
    assert.equal(writes[0].model, 'deepseek/new-flash');
    assert.equal(writes[0].reasoningEffort, 'max');
    assert.equal(q.sent.length, 1);
    assert.equal(q.sent[0][1], 'Test message');

    q.drafts.getState().setText('new:conversation', 'Keep this draft');
    q.connections.setState({ connections: [{ ...edited, revision: 4, models: [{ ...model('deepseek/new-flash'), enabled: false }] }, account] });
    await settle();
    assert.equal(send().disabled, true);
    assert.equal(d.querySelector('textarea').disabled, false, 'configuration errors do not prevent composing');
    assert.match(send().title, /保存并启用一个模型/);
    assert.equal(d.querySelector('textarea').value, 'Keep this draft');

    q.connections.setState({ connections: [{ ...edited, hasCredential: false }, account] });
    await settle();
    assert.equal(send().disabled, true);
    assert.match(send().title, /API Key/);

    q.connections.setState({ connections: [edited, account] });
    q.agents.setState({ instances: [{ ...q.agents.getState().instances[0], baseArgs: ['--custom-routing'] }] });
    await settle();
    assert.equal(send().disabled, true);
    assert.match(send().title, /不兼容/);

    // Selecting native explicitly must clear the API revision/model and stay
    // selected even when there is exactly one managed connection available.
    q.agents.setState({ instances: [{ ...q.agents.getState().instances[0], baseArgs: [] }] });
    q.connections.setState({ connections: [edited] });
    await settle();
    await openModels();
    await chooseSource(menu().querySelector('[aria-label="供应商或账号"]'), '使用 Harness 原生配置');
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'native-default');
    assert.equal(send().disabled, false);
    assert.equal(d.querySelector('.starter-context [aria-label="供应商或账号"]').textContent, '原生配置');
    await openModels();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1);
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'native-default');
    menu().querySelector('.model-menu-option').click();
    await settle();
    send().click();
    await settle();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].connectionId, undefined);
    assert.equal(writes[1].connectionRevision, undefined);
    assert.equal(writes[1].model, 'native-default');
    assert.notEqual(writes[1].reasoningEffort, 'max', 'API reasoning settings cannot leak into native config');

    // Native discovery is optional: without a catalog or saved accounts the
    // CLI still receives an unbound session and uses its own defaults.
    q.connections.setState({ connections: [] });
    q.agents.setState({ modelCatalogs: {}, loadModels: async () => { throw Error('Native discovery unavailable'); } });
    q.drafts.getState().setText('new:conversation', 'Use native defaults');
    q.render('native-defaults');
    await settle(); await settle();
    assert.equal(send().disabled, false);
    assert.match(d.querySelector('.composer-model-trigger').textContent, /原生默认模型/);
    send().click();
    await settle();
    assert.equal(writes.length, 3);
    for (const field of ['connectionId', 'connectionRevision', 'model', 'reasoningEffort']) {
      assert.equal(writes[2][field], undefined, `native defaults must not inject ${field}`);
    }

    // Existing conversations remain bound to their immutable historical source.
    q.connections.setState({ connections: [edited, account] });
    q.agents.setState({ instances: [{ ...q.agents.getState().instances[0], providerId: 'deepseek', baseArgs: [] }] });
    q.sessions.setState({ sessions: [{ id: 'old', projectId: 'p', title: 'Existing chat', target: { type: 'agent', instanceId: 'h' }, connectionId: 'deepseek', connectionRevision: 1, model: 'deepseek/flash', status: 'idle', createdAt: now, updatedAt: now, unreadCount: 0 }], foreground: { old: { status: 'running' } } });
    q.drafts.getState().setText('old', 'Use the previous context');
    q.render('existing', 'old', true);
    await settle(); await settle();
    await openModels();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1);
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'deepseek/flash');
    assert.ok(historicalReads.includes(1));
    assert.equal(q.sessions.getState().sessions[0].connectionRevision, 1);
    assert.equal(q.connections.getState().connections[0].revision, 3);
    await chooseSource(menu().querySelector('[aria-label="供应商或账号"]'), 'Antigravity');
    assert.equal(q.configured.length, 0, 'selecting while running does not write the active configuration');
    assert.equal(enabledRoutes.length, 0, 'selecting does not enable cross-harness access before sending');
    assert.equal(q.sessions.getState().sessions[0].connectionId, 'deepseek');
    assert.equal(q.sessions.getState().nextTurnModels.old.connectionId, 'account');
    assert.match(d.querySelector('.composer-model-trigger').title, /Antigravity.*gemini-flash/);
    assert.doesNotMatch(d.querySelector('.composer-model-trigger').textContent, /Antigravity/);
    assert.match(menu().querySelector('[aria-label="供应商或账号"]').textContent, /Antigravity/);
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'gemini-flash');
    assert.equal(d.querySelector('[role="alertdialog"]'), null);
    assert.equal(send().disabled, true, 'draft is not sent as steering to the previous account');
    d.querySelector('textarea').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    assert.equal(q.followUps.length, 0);
    assert.equal(d.querySelector('textarea').value, 'Use the previous context');

    // The selection survives view changes, and only the next explicit send
    // commits the new binding. Rejecting that write must leave the draft local.
    q.sessions.setState({ foreground: { old: { status: 'completed' } } });
    q.render('reopened', 'old');
    await settle();
    assert.equal(send().disabled, false);
    blockSwitch = true;
    send().click();
    await settle();
    assert.equal(deliveries.length, 0);
    assert.equal(q.sessions.getState().sessions[0].connectionId, 'deepseek');
    assert.equal(q.sessions.getState().nextTurnModels.old.connectionId, 'account');
    assert.equal(d.querySelector('textarea').value, 'Use the previous context');
    blockSwitch = false;
    send().click();
    await settle(); await settle();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].sessionId, 'old');
    assert.equal(deliveries[0].text, 'Use the previous context');
    assert.equal(deliveries[0].connectionId, 'account');
    assert.equal(deliveries[0].model, 'gemini-flash');
    assert.equal(enabledRoutes.length, 1);
    assert.equal(enabledRoutes[0].connectionId, 'account');
    const savedSwitch = writes.find(input => input.id === 'old' && input.confirmConnectionChange);
    assert.equal(savedSwitch.connectionRevision, 1);
    assert.equal(savedSwitch.reasoningEffort, '');
    assert.equal(q.sessions.getState().nextTurnModels.old, undefined);

    const editor = () => d.querySelector('textarea');
    const key = (name) => editor().dispatchEvent(new w.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    const input = async (text, caret = text.length) => {
      editor().focus();
      Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(editor(), text);
      editor().setSelectionRange(caret, caret);
      editor().dispatchEvent(new w.InputEvent('input', { bubbles: true }));
      await settle();
    };
    await input('用@pd 处理账单', 4);
    assert.match(d.querySelector('.composer-reference-list [role="option"]').textContent, /PDF.*原生/);
    assert.doesNotMatch(d.querySelector('.composer-reference-list').textContent, /PDF disabled|Other harness/);
    key('Enter');
    await settle();
    assert.equal(editor().value, '用@PDF  处理账单');
    assert.equal(editor().selectionStart, 7);
    assert.equal(d.querySelector('.composer-reference-mirror [data-kind="skill"]').textContent, '@PDF');
    assert.ok(d.querySelector('.composer-inline-reference-icon svg'), 'render an icon within the reference');
    assert.equal(d.querySelector('.composer-reference-strip'), null);

    await input('用@PDF 处理账单，再用 @Play');
    key('ArrowRight');
    await settle();
    assert.match(d.querySelector('.composer-reference-back').textContent, /Playwright.*工具.*1/);
    assert.match(d.querySelector('.composer-reference-list [role="option"]').textContent, /browser_snapshot/);
    key('Enter');
    await settle();
    assert.equal(editor().value, '用@PDF 处理账单，再用 @Playwright / browser_snapshot  ');
    send().click();
    await settle();
    assert.equal(deliveries[1].text, '用@PDF 处理账单，再用 @Playwright / browser_snapshot');
    assert.deepEqual(JSON.parse(JSON.stringify(deliveries[1].references)), [
      { kind: 'skill', id: 'native:skill:pdf' }, { kind: 'mcp', id: 'browser', tool: 'browser_snapshot' }
    ]);
    d.querySelector('.composer-reference-trigger').click();
    await settle();
    assert.equal(editor().value, '', 'opening the menu from the toolbar leaves the draft untouched');
    assert.match(d.querySelector('.composer-reference-list [role="option"]').textContent, /Playwright \/ browser_snapshot/);
    key('Tab');
    await settle();
    assert.match(d.querySelector('.composer-reference-tabs [aria-pressed="true"]').textContent, /Skill/);
    key('Escape');
    await settle();
    assert.equal(d.querySelector('.composer-reference-list'), null);
    await input('下一步 /');
    assert.match(d.querySelector('.composer-reference-tabs [aria-pressed="true"]').textContent, /工作流/);
    editor().dispatchEvent(new w.CompositionEvent('compositionstart', { bubbles: true }));
    await settle();
    assert.equal(key('Enter'), true, 'the composer does not take over the IME confirmation key');
    assert.equal(deliveries.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    dom?.window.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
