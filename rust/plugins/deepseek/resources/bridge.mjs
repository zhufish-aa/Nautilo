// Nautilo's transport extension. The user's native Web profile still owns
// presets, tools, model adapters, permissions, plugins and session persistence.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

export const name = 'nautilo-transport';
export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'sessions', 'agentPresets', 'permissionPresets', 'llm', 'tools', 'loader'];
const emit = (kind, data) => process.stdout.write(`@nautilo-dsh:${JSON.stringify({ kind, ...data })}\n`);

export async function apply(ctx, config = {}) {
  const token = process.env.NAUTILO_DSH_TOKEN;
  if (!token) throw new Error('Missing Nautilo transport token');
  const pending = new Map();
  const failures = new Map();
  const malformedCalls = new Set();
  const sessions = new Set();
  const parents = new Map();
  const agentLifetimes = new WeakMap();
  const activeRequests = new Set();
  const lifetime = new AbortController();
  function owns(sessionId) {
    const seen = new Set();
    while (sessionId && !seen.has(sessionId)) {
      if (sessions.has(sessionId)) return true;
      seen.add(sessionId); sessionId = parents.get(sessionId);
    }
    return false;
  }
  let binding;
  async function bindConnection() {
    if (!config.connection) return Promise.resolve();
    if (binding) {
      await binding;
      return;
    }
    return binding ??= (async () => {
      const started = performance.now();
      const pendingPlugins = [...ctx.loader.entries()]
        .filter(entry => entry._initTask || entry.fiber?.inertia)
        .map(entry => entry.options.name);
      await ctx.loader.await();
      const loaded = performance.now();
      const entry = [...ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-llm-pi-ai');
      if (!entry?.fiber) throw new Error('The native profile has no active multi-provider adapter');
      // Volatile snapshots are deeply frozen. Schemastery normalizes nested
      // dictionaries in place (including valid `off: null` entries), so feeding
      // the snapshot back into validation fails even though its values are valid.
      const previous = structuredClone(entry.fiber.config.providers.get());
      // Entry.update applies native volatile fields in place. Fiber.update
      // restarts the adapter and its dependants even when only a route changes.
      // Retain the profile's raw options so later native settings writes cannot
      // persist this session's temporary gateway address or credential reference.
      const storedConfig = entry.options.config;
      try {
        await entry.update({ config: {
          ...storedConfig,
          providers: { ...previous, [config.connection.provider]: config.connection.profile },
        } });
      } finally {
        entry.options.config = storedConfig;
      }
      await ctx.loader.await();
      const applied = entry.fiber.config.providers.get()[config.connection.provider];
      if (applied?.apiKeyEnv !== config.connection.profile.apiKeyEnv || applied?.baseURL !== config.connection.profile.baseURL) {
        throw new Error('DeepSeek could not apply the selected connection');
      }
      return { loaderWaitMs: Math.round(loaded - started), providerUpdateMs: Math.round(performance.now() - loaded), pendingPlugins };
    })();
  }

  function ask(kind, data, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Request cancelled'));
      const id = randomUUID();
      const abort = () => { pending.delete(id); emit('interaction_cancel', { id }); reject(new Error('Request cancelled')); };
      pending.set(id, answer => { signal?.removeEventListener('abort', abort); resolve(answer); });
      signal?.addEventListener('abort', abort, { once: true });
      emit(kind, { id, ...data });
    });
  }

  ctx.on('session/event', (session, event) => {
    if (owns(session.id) && event.type === 'turn/end' && event.data?.reason?.kind === 'max-tokens') {
      failures.set(session.id, '模型输出达到长度上限，本轮回答未完成。已保留生成内容，可以继续对话。');
    }
    if (owns(session.id) && event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      // DSML printed as assistant prose is not a native tool call. Never eval
      // that text, or claim a successful execution after the agent goes idle.
      const malformed = blocks.some(block => block.type === 'text' && /^\s*<\s*[|｜]\s*DSML\s*[|｜]\s*(?:invoke|function_calls)\b/u.test(block.text ?? ''));
      if (malformed) malformedCalls.add(session.id); else malformedCalls.delete(session.id);
    }
    emit('event', { sessionId: session.id, event });
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // DSH attempt IDs are unique only within one attached Agent lifecycle.
    // Resuming the same saved session can restart its counter at 1. Keep one
    // namespace per Agent, so a new reply cannot resolve to an old run while
    // late frames from an existing agent/child retain their original identity.
    let lifetime = agentLifetimes.get(agent);
    if (!lifetime) agentLifetimes.set(agent, lifetime = randomUUID());
    emit('stream', { sessionId: agent.session.id, frame: { ...frame, attemptId: `${lifetime}:${frame.attemptId}` } });
  });
  ctx.on('agent/error', ({ agent, error }) => {
    failures.set(agent.session.id, error instanceof Error ? error.message : String(error));
  });
  ctx.on('agent/status', ({ agent, status }) => {
    emit('status', { sessionId: agent.session.id, status });
  });
  ctx.on('session/created', session => {
    if (!session.header.parentSession) return;
    parents.set(session.id, session.header.parentSession);
    emit('child', { parentSessionId: session.header.parentSession, childSessionId: session.id, phase: 'started' });
  });
  ctx.on('subagent/end', info => {
    const parentSessionId = parents.get(info.id);
    if (info.local && parentSessionId) emit('child', { parentSessionId, childSessionId: info.id, phase: 'completed', failed: info.stopReason !== 'completed' });
  });
  // Native Web remotes are also answerers in this waterfall. Claim only our
  // sessions before forwarding can wait for a different, unopened native UI.
  ctx.on('approval/request', async (request, next) => {
    if (!request.agent || !owns(request.agent.session.id)) return next();
    const response = await ask('approval', {
      sessionId: request.agent.session.id, title: request.toolName,
      detail: request.displayReason?.['zh-CN'] ?? request.reason ?? '', callId: request.callId
    }, request.signal).catch(() => ({ outcome: 'cancelled' }));
    return response.outcome === 'selected' && response.optionId === 'once' ? 'allowed-once'
      : response.outcome === 'cancelled' ? 'cancelled' : 'rejected';
  }, { prepend: true });
  ctx.on('user-questions/request', async (request, next) => {
    if (!request.agent || !owns(request.agent.session.id)) return next();
    const questions = request.questions.map(question => ({
      id: question.id, header: question.header, question: question.detail ? `${question.question}\n\n${question.detail}` : question.question,
      multiSelect: question.multiSelect, isOther: true,
      options: question.options?.map((option, index) => ({ id: String(index), label: option.label, description: option.description }))
    }));
    const response = await ask('question', { sessionId: request.agent.session.id, callId: request.wait?.callId, questions }, request.signal);
    if (response.outcome !== 'selected') throw new Error('Question cancelled');
    return { answers: request.questions.map(question => {
      const answers = response.answers?.[question.id] ?? [];
      const options = new Set(question.options?.map(option => option.label));
      return { id: question.id, selected: answers.filter(value => options.has(value)), custom: answers.filter(value => !options.has(value)).join('\n') || undefined };
    }) };
  }, { prepend: true });

  // Host tools are added as ordinary tools; no native tool is replaced.
  for (const tool of config.tools ?? []) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args, exec) {
        if (!exec.agent || !owns(exec.agent.session.id)) throw new Error('Nautilo tools are scoped to its own session');
        const result = await ask('host_tool', { sessionId: exec.agent.session.id, name: tool.name, arguments: args }, exec.signal);
        if (!result.success) throw new Error(result.content || 'Nautilo tool failed');
        return result.content ?? '';
      }
    }));
  }

  async function idleTree(agent) {
    for (;;) {
      await agent.whenIdle();
      const seq = agent.session.seq;
      const children = await ctx.get('subagents')?.waitForChildren(agent);
      if (!children && agent.status === 'idle' && seq === agent.session.seq) break;
    }
    await ctx.sessions.flush(agent.session);
    emitContext(agent);
    const error = failures.get(agent.session.id);
    if (error) throw new Error(error);
    if (malformedCalls.has(agent.session.id)) throw new Error('上游把工具调用作为 DSML 文本返回，原生 Harness 未执行这段代码。请重试。');
  }

  function emitContext(agent) {
    // Reuse DSH's own pressure measurement, including its restored surface and
    // compaction result. Never use cumulative billed tokens as context size.
    try {
      const meter = agent.ctx?.get('tokenMeter') ?? ctx.get('tokenMeter');
      const measurement = meter?.measure(agent.session);
      const contextWindow = agent.session.requestContext?.()?.contextWindow;
      if (Number.isSafeInteger(measurement?.totalTokens) || Number.isSafeInteger(contextWindow)) {
        emit('context', { sessionId: agent.session.id, contextUsed: measurement?.totalTokens, contextWindow });
      }
    } catch (error) {
      emit('diagnostic', { sessionId: agent.session.id, message: `Native context measurement unavailable: ${error.message ?? error}` });
    }
  }

  async function managePlugins(operation) {
    const manager = ctx.get('pluginManager');
    if (!manager) throw new Error('This DeepSeek profile has no native plugin manager');
    const bundles = await manager.listBundles();
    const entries = await manager.listPlugins();
    const items = [];
    const targets = new Map();
    for (const bundle of bundles) {
      const present = bundle.availability !== 'missing';
      const actions = [];
      if (!bundle.readOnlyReason && !bundle.error) {
        if (present) actions.push(bundle.enabled ? 'disable' : 'enable');
        else if (bundle.installTarget) actions.push('install');
      }
      if (bundle.removable && !bundle.readOnlyReason) actions.push('remove');
      const id = 'bundle:' + bundle.name;
      items.push({ id, name: bundle.name, version: bundle.version, description: bundle.description,
        source: 'Bundle', installed: present, enabled: bundle.enabled, actions });
      targets.set(id, { bundle, actions });
    }
    for (const entry of entries) {
      // Address editable rows by their persistent profile patch, not by a loader instance's ID.
      if (entry.patchId === 'nautilo-transport' || entry.moduleName === import.meta.url) continue;
      const id = entry.patchId ? 'entry:' + entry.patchId : 'readonly:' + entry.entryId;
      const actions = entry.patchId && !entry.readOnlyReason ? [entry.enabled ? 'disable' : 'enable'] : [];
      items.push({ id, name: entry.moduleName, source: entry.patchId ?? entry.entryId, installed: true, enabled: entry.enabled, actions });
      targets.set(id, { entry, actions });
    }
    if (operation.action === 'list') return { items, installBySpec: true };
    let result;
    if (operation.action === 'install' && typeof operation.spec === 'string') {
      const spec = operation.spec.trim();
      if (!spec || spec.length > 2048) throw new Error('Invalid DeepSeek package spec');
      result = await manager.installBundle(spec);
    } else {
      const target = targets.get(operation.id);
      // The maintenance overlay disables its own HMR process. The user's HMR
      // preference is still editable through the native profile patch API.
      const editingHmr = target?.entry?.patchId === 'hmr' && !target.entry.readOnlyReason && ['enable', 'disable'].includes(operation.action);
      if (!target || !(editingHmr || target.actions.includes(operation.action))) throw new Error('This native plugin action is unavailable');
      if (operation.action === 'install') result = await manager.installBundle(target.bundle.installTarget.spec);
      else if (operation.action === 'remove') result = await manager.removeBundle(target.bundle.name);
      else if (target.entry) result = await manager.setPluginEnabled(target.entry.entryId, operation.action === 'enable');
      else result = await manager.setBundleEnabled(target.bundle.name, operation.action === 'enable');
    }
    if (result.error || !['applied', 'restart-required', 'overridden'].includes(result.application)) {
      throw new Error(result.error?.diagnostic || result.error?.code || result.packageResult?.kind || result.application || 'DeepSeek plugin operation failed');
    }
    return { application: result.application };
  }

  async function route(path, body) {
    if (path === '/plugins') return managePlugins(body);
    if (path === '/drain') {
      await new Promise(resolve => process.stdout.write(`@nautilo-dsh:${JSON.stringify({kind:'barrier',id:body.id})}\n`,resolve));
      return {};
    }
    if (path === '/catalog') {
      await bindConnection();
      const [models, modes] = await Promise.all([ctx.sessionController.modelCatalog(), ctx.agentPresets.list()]);
      return { models, modes, defaultMode: ctx.agentPresets.defaultId };
    }
    if (path === '/answer') {
      const answer = pending.get(body.id);
      if (!answer) return { accepted: false };
      pending.delete(body.id);
      answer(body.answer);
      return { accepted: true };
    }
    if (path === '/open') {
      const started = performance.now();
      if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) throw new Error('缺少该会话的工作区目录');
      const bindingTimings = await bindConnection();
      const bound = performance.now();
      let sessionId = body.sessionId;
      if (!body.resume) {
        const workspace = await ctx.workspaceRegistry.create(body.cwd);
        const created = await ctx.sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: body.agentMode || undefined });
        sessionId = created.sessionId;
      }
      const created = performance.now();
      const { agent } = await ctx.sessionController.resolveAgent(sessionId);
      if (!agent) throw new Error('DeepSeek did not restore the requested agent');
      if (body.resume) {
        const stored = agent.session.header.cwd;
        if (!stored || relative(await realpath(body.cwd), await realpath(stored)) !== '') {
          throw new Error(`DeepSeek 会话目录（${stored ?? '未知'}）与当前工作区（${body.cwd}）不一致`);
        }
        const workspace = await ctx.workspaceRegistry.create(body.cwd);
        if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId);
      }
      const resolved = performance.now();
      const selectedMode = ctx.agentPresets.composedPreset(agent.ctx);
      if (body.agentMode && body.agentMode !== selectedMode) await ctx.agentPresets.select(agent, body.agentMode);
      if (body.model) await ctx.sessionController.selectModel({ sessionId, provider: body.provider, model: body.model,
        ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}) });
      if (body.permissionMode) ctx.permissionPresets.set(agent.session, body.permissionMode);
      sessions.add(sessionId);
      emitContext(agent);
      const compaction = ctx.agentPresets.serviceFor(agent, 'compaction') ?? ctx.get('compaction');
      return { sessionId, agentMode: ctx.agentPresets.composedPreset(agent.ctx), permissionMode: ctx.permissionPresets.current(agent.session),
        timings: { providerBindMs: Math.round(bound - started), sessionCreateMs: Math.round(created - bound),
          agentResolveMs: Math.round(resolved - created), preferencesMs: Math.round(performance.now() - resolved),
          ...bindingTimings },
        supportsCompact: typeof compaction?.compactNow === 'function' };
    }
    if (!sessions.has(body.sessionId)) throw new Error('Session is not owned by this Nautilo connection');
    if (path === '/cancel') return ctx.sessionController.cancel({ sessionId: body.sessionId });
    if (path === '/prompt') {
      failures.delete(body.sessionId);
      malformedCalls.delete(body.sessionId);
      return ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: body.sessionId,
        mode: body.mode === 'steer' ? 'steer' : 'queue', content: body.content }, lifetime.signal);
    }
    const { agent } = await ctx.sessionController.resolveAgent(body.sessionId);
    if (path === '/wait') { await idleTree(agent); return {}; }
    if (path === '/compact') {
      const compaction = ctx.agentPresets.serviceFor(agent, 'compaction') ?? ctx.get('compaction');
      if (!compaction?.compactNow) throw new Error('This DeepSeek mode has no manual compaction capability');
      try {
        await compaction.compactNow(agent, lifetime.signal);
      } catch (error) {
        // DSH wraps the model's error in a generic ManualCompactionError.
        const messages = new Set();
        for (let cause = error, depth = 0; cause != null && depth < 8; cause = cause.cause, depth++) {
          const message = typeof cause === 'string' ? cause : cause.message;
          if (message) messages.add(message);
        }
        throw new Error([...messages].join('\n') || String(error));
      }
      await idleTree(agent);
      return {};
    }
    throw new Error('Unknown Nautilo transport operation');
  }

  const server = createServer(async (req, res) => {
    const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401).end(); return;
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const task = (async () => {
      try {
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 40 * 1024 * 1024) throw new Error('Transport request is too large');
          chunks.push(chunk);
        }
        const result = await route(req.url, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.message ?? String(error) }));
      }
    })();
    activeRequests.add(task);
    try { await task; } finally { activeRequests.delete(task); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  ctx.effect(() => async () => {
    lifetime.abort();
    for (const answer of pending.values()) answer({ outcome: 'cancelled' });
    pending.clear();
    server.closeAllConnections(); server.close();
    await Promise.allSettled(activeRequests);
  });
  emit('ready', { port: server.address().port });
}
