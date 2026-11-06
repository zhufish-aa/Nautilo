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

test('configured API models, draft revisions and sending stay consistent across settings changes', {
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
    await esbuild.build({
      stdin: {
        resolveDir: desktop, loader: 'tsx', contents: `
          import React from 'react';
          import {createRoot} from 'react-dom/client';
          import {MemoryRouter} from 'react-router-dom';
          import {NewConversation} from '${src}/features/sessions/NewConversation';
          import {SessionModelControl} from '${src}/features/sessions/SessionModelControl';
          import {I18nProvider} from '${src}/lib/i18n';
          import {TooltipProvider} from '${src}/components/ui/Tooltip';
          import {useAgentsStore as agents} from '${src}/stores/agents';
          import {useProjectsStore as projects} from '${src}/stores/projects';
          import {useConnectionsStore as connections} from '${src}/stores/connections';
          import {useSessionsStore as sessions} from '${src}/stores/sessions';
          import {useTeamsStore as teams} from '${src}/stores/teams';
          import {useComposerDraftsStore as drafts} from '${src}/stores/composer-drafts';
          const root=createRoot(document.getElementById('root'));
          window.qa={agents,projects,connections,sessions,teams,drafts,sent:[],created:[],
            render:(key='draft',sessionId)=>root.render(<MemoryRouter><I18nProvider><TooltipProvider>
              {sessionId ? <SessionModelControl key={key} sessionId={sessionId}/> : <NewConversation key={key} onCreated={id=>window.qa.created.push(id)}/>}
            </TooltipProvider></I18nProvider></MemoryRouter>)};
        `,
      },
      outfile: output, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      nodePaths: [join(desktop, 'node_modules')], define: { 'process.env.NODE_ENV': '"test"' },
      plugins: [{ name: 'no-cli', setup(build) {
        build.onResolve({ filter: /orchestration-runtime$/ }, () => ({ path: 'runtime', namespace: 'no-cli' }));
        build.onLoad({ filter: /.*/, namespace: 'no-cli' }, () => ({ contents: runtimeNames.map(name =>
          `export async function ${name}(...args){${name === 'sendWorkbenchMessage' ? 'window.qa.sent.push(args);' : ''}}`
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
    w.agenthub = { core: { request: async ({ method, input }) => {
      if (method !== 'session.upsert') throw Error(`Unexpected IPC: ${method}`);
      writes.push(input);
      return input;
    } } };
    w.eval(await readFile(output, 'utf8'));
    const q = w.qa;
    const settle = () => new Promise(resolve => w.setTimeout(resolve, 70));
    const now = '2026-11-03T00:00:00Z';
    const model = id => ({ id, displayName: id, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'low', capabilities: [], serviceTiers: [] });
    const saved = { id: 'deepseek', name: 'DeepSeek', kind: 'api', protocol: 'chat', enabled: true, hasCredential: true, revision: 1, models: [model('deepseek/flash')], createdAt: now, updatedAt: now };
    const account = { ...saved, id: 'account', name: 'Codex account', kind: 'login', harness: 'codex', models: [model('account-model')] };
    const historicalReads = [];
    q.connections.setState({ connections: [saved, account], hydrate: async () => {}, get: async (id, revision) => { historicalReads.push(revision); return { ...saved, revision }; } });
    q.agents.setState({ instances: [{ id: 'h', providerId: 'codex', configurationKind: 'harness', displayName: 'Codex', executable: 'codex', baseArgs: [], enabled: true, status: 'available' }] });
    q.projects.setState({ projects: [{ id: 'p', name: 'Project', rootPath: '/test', verificationTemplates: [] }] });
    q.teams.setState({ teams: [] });
    q.drafts.getState().setText('new:conversation', 'Test message');
    q.render();
    await settle(); await settle();
    const send = () => d.querySelector('.composer-send');
    const menu = () => d.querySelector('.composer-model-menu');
    const openModels = async () => { d.querySelector('.composer-model-trigger').click(); await settle(); };
    assert.equal(send().disabled, true, 'multiple sources require an explicit account selection');
    assert.equal(d.querySelector('.composer [role="status"]'), null, 'the composer does not show the removed configuration hint');
    const provider = d.querySelector('[aria-label="供应商或账号"]');
    provider.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    const option = [...d.querySelectorAll('[role="option"]')].find(item => item.textContent === 'DeepSeek');
    assert.ok(option, 'the saved API provider is selectable');
    option.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(); await settle();
    assert.equal(send().disabled, false, 'one saved API model makes a typed draft sendable');
    await openModels();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1);
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'deepseek/flash');

    q.connections.setState({ modelCatalogs: { 'deepseek:1': { providerId: 'connection:deepseek', models: [model('Claude Sonnet'), model('unconfigured')], defaultModel: 'Claude Sonnet', source: 'provider_api', fetchedAt: now } } });
    await settle();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1, 'a broad discovery result cannot expand configured models');
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'deepseek/flash');
    menu().querySelector('.model-menu-option').click();
    await settle();
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

    // Existing conversations remain bound to their immutable historical source.
    q.agents.setState({ instances: [{ ...q.agents.getState().instances[0], providerId: 'codex', baseArgs: [] }] });
    q.sessions.setState({ sessions: [{ id: 'old', target: { type: 'agent', instanceId: 'h' }, connectionId: 'deepseek', connectionRevision: 1, model: 'deepseek/flash', status: 'idle' }] });
    q.render('existing', 'old');
    await settle(); await settle();
    await openModels();
    assert.equal(menu().querySelectorAll('.model-menu-option').length, 1);
    assert.equal(menu().querySelector('.model-menu-option').textContent, 'deepseek/flash');
    assert.ok(historicalReads.includes(1));
    assert.equal(q.sessions.getState().sessions[0].connectionRevision, 1);
    assert.equal(q.connections.getState().connections[0].revision, 3);
    assert.deepEqual(errors, []);
  } finally {
    dom?.window.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
