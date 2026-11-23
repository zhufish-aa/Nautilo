// Pi-only deterministic RPC peer. No account, model, or network is used.
import { createInterface } from 'node:readline';

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let turns = 0;
let thinkingLevel = 'high';
let model = { provider: 'test', id: 'test-model' };

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'get_state') {
    emit({ type: 'response', id: frame.id, success: true, data: {
      sessionId: 'stream-identity-session', model, thinkingLevel,
      isStreaming: false, isCompacting: false, queuedMessageCount: 0
    } });
  } else if (frame.type === 'set_thinking_level') {
    thinkingLevel = frame.level;
    emit({ type: 'response', id: frame.id, success: true });
  } else if (frame.type === 'set_model') {
    model = { provider: frame.provider, id: frame.modelId };
    emit({ type: 'response', id: frame.id, success: true });
  } else if (frame.type === 'prompt') {
    const text = `${process.pid}:${++turns}:${frame.message}`;
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    const finish = () => emit({ type: 'message_end', message: {
      role: 'assistant', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'thinking' }], stopReason: 'stop'
    } });
    if (frame.message === 'late') {
      // The message is still open after the foreground turn releases its stream.
      emit({ type: 'agent_settled', isTerminal: true });
      setTimeout(() => {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ':late' } });
        finish();
      }, 40);
    } else {
      finish();
      emit({ type: 'agent_settled', isTerminal: true });
    }
  } else {
    emit({ type: 'response', id: frame.id, success: true, data: { commands: [] } });
  }
}
