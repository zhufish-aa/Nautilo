// A deterministic native event source exercising the real supplemental bridge.
// It never loads a model, user profile or network provider.
import { readFile } from 'node:fs/promises';
const patch = JSON.parse(await readFile(process.argv[process.argv.indexOf('--patch') + 1], 'utf8'));
const transport = patch[0].insert.find(entry => entry.id === 'nautilo-transport');
const { apply } = await import(transport.name);
const listeners = new Map(), agents = new Map(), tools = new Map();
let sequence = 0;
const fire = (name, ...args) => listeners.get(name)?.(...args);
const event = (agent, type, data) => fire('session/event', agent.session, { seq: ++sequence, type, data });
function agent(id, parentSession) {
  const result = { session: { id, seq: 0, header: { parentSession } }, ctx: {}, status: 'idle', count: 0, async whenIdle() { await this.done; } };
  agents.set(id, result); return result;
}
function message(a, text) {
  const attemptId = `${a.session.id}-${++a.count}`;
  fire('agent/assistant-stream', { agent: a, frame: { type: 'chunk', attemptId, chunk: { type: 'text-delta', index: 0, text } } });
  event(a, 'assistant/message', { turn: a.count, step: 0, message: { content: [{ type: 'text', text }] } });
}
const ctx = {
  on(name, fn) { listeners.set(name, fn); }, effect(fn) { fn(); },
  get(name) { return name === 'subagents' ? { async waitForChildren() { return false; } } : undefined; },
  tools: { register(tool) { tools.set(tool.name, tool); } },
  sessions: { async flush() {} },
  permissionPresets: { set() {} },
  agentPresets: { defaultId: 'standard', async list() { return [{ id: 'standard' }, { id: 'ptc' }]; }, composedPreset() { return 'standard'; }, async select() {}, serviceFor() {} },
  sessionController: {
    async create({ sessionId }) { agent(sessionId); return { sessionId }; },
    async resolveAgent(id) { return { agent: agents.get(id) }; },
    async modelCatalog() { return { default: { provider: 'fixture', model: 'test' }, groups: [] }; },
    async selectModel() {}, async cancel() {},
    async prompt({ sessionId, content }) {
      const root = agents.get(sessionId), text = content.find(block => block.type === 'text')?.text;
      message(root, `${process.pid}:${root.count + 1}:${text}`);
      if (text === 'background' || text === 'pending') {
        const child = agent(`${sessionId}-child`, sessionId);
        fire('session/created', child.session);
        root.child = child;
        event(child, 'tool/call', { callId: 'late-read', name: 'read', arguments: { path: 'background.txt' } });
        setTimeout(async () => {
          message(child, 'child-after-parent-turn');
          const controller = new AbortController(); root.controller = controller;
          const answer = fire('approval/request', { agent: child, toolName: 'background-read', callId: 'late-read', signal: controller.signal }, () => { throw new Error('Approval escaped the bridge'); });
          if (text === 'pending') setTimeout(() => controller.abort(), 60);
          const outcome = await answer;
          if (outcome === 'allowed-once') {
            const result = await tools.get('nautilo_fixture').execute({ value: 'background' }, { agent: child, signal: new AbortController().signal });
            event(child, 'tool/result', { message: { toolCallId: 'late-read', content: [{ type: 'text', text: result }] } });
            message(child, 'background-approved');
          }
        }, 60);
      }
      if (text === 'second') {
        // The old child emits while the next parent turn is active.
        message(root.child, 'old-child-during-next-turn');
        root.done = new Promise(resolve => setTimeout(resolve, 90));
      }
      return {};
    }
  }
};
await apply(ctx, transport.config);
