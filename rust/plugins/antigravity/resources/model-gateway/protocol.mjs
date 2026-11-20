// Chat/Anthropic wire projection ported from yetone/magpie
// 4a1ac84421145de4c4078898c6441487ac45bd5e internal/gateway/{anthropic,chat}.go.
// Native account/session/tool handling is the unmodified upstream agy-cli code.
import { createHash, randomUUID } from 'node:crypto';

const callId = id => /^[A-Za-z0-9_-]+$/.test(id) ? id : 'call_' + createHash('sha256').update(id).digest('hex').slice(0, 40);
function blocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return (content ?? []).flatMap(part => {
    if (part.type === 'text') return [part];
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url ?? '');
      return [{ type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url } }];
    }
    return [part];
  });
}
export function fromChat(input) {
  const messages = [], system = [];
  const push = (role, content) => {
    if (!content.length) return;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  };
  for (const message of input.messages ?? []) {
    if (['system', 'developer'].includes(message.role)) { system.push(...blocks(message.content)); continue; }
    if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: callId(message.tool_call_id), content: blocks(message.content) }]); continue;
    }
    const content = blocks(message.content);
    for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: callId(call.id), name: call.function.name, input: JSON.parse(call.function.arguments || '{}') });
    push(message.role, content);
  }
  const body = { model: input.model, messages, system, stream: true, max_tokens: input.max_completion_tokens ?? input.max_tokens ?? 8192 };
  if (input.tools?.length) body.tools = input.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters ?? { type: 'object', properties: {} } }));
  if (input.tool_choice) body.tool_choice = typeof input.tool_choice === 'string'
    ? { type: ({ required: 'any' })[input.tool_choice] ?? input.tool_choice }
    : { type: 'tool', name: input.tool_choice.function.name };
  for (const field of ['temperature', 'top_p', 'reasoning_effort', 'metadata']) if (input[field] !== undefined) body[field] = input[field];
  if (input.stop) body.stop_sequences = Array.isArray(input.stop) ? input.stop : [input.stop];
  return body;
}

export function toChat(response, input) {
  if (!response.ok) return response;
  const id = 'chatcmpl-' + randomUUID();
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const tools = new Map(); let text = '', reasoning = '', stop = 'stop', complete = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({ async start(controller) {
    const emit = (delta, finish = null, counts) => controller.enqueue(encoder.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', model: input.model, choices: counts ? [] : [{ index: 0, delta, finish_reason: finish }], ...(counts ? { usage: counts } : {}) }) + '\n\n'));
    const frame = event => {
      switch (event.type) {
        case 'error': throw new Error(event.error?.message ?? 'The native account stream failed');
        case 'message_start':
          Object.assign(usage, { prompt_tokens: event.message?.usage?.input_tokens ?? 0, completion_tokens: event.message?.usage?.output_tokens ?? 0 });
          emit({ role: 'assistant' }); break;
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            const index = tools.size, call = { index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } };
            tools.set(event.index, call); emit({ tool_calls: [call] });
            if (block.input && Object.keys(block.input).length) { call.function.arguments = JSON.stringify(block.input); emit({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }); }
          } else if (block.type === 'text' && block.text) { text += block.text; emit({ content: block.text }); }
          else if (block.type === 'thinking' && block.thinking) { reasoning += block.thinking; emit({ reasoning_content: block.thinking }); }
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'text_delta') { text += delta.text; emit({ content: delta.text }); }
          else if (delta.type === 'thinking_delta') { reasoning += delta.thinking; emit({ reasoning_content: delta.thinking }); }
          else if (delta.type === 'input_json_delta') {
            const call = tools.get(event.index); if (!call) throw new Error('Tool arguments arrived before the native tool call');
            call.function.arguments += delta.partial_json; emit({ tool_calls: [{ index: call.index, function: { arguments: delta.partial_json } }] });
          }
          break;
        }
        case 'message_delta':
          if (event.usage?.output_tokens !== undefined) usage.completion_tokens = event.usage.output_tokens;
          if (event.usage?.input_tokens !== undefined) usage.prompt_tokens = event.usage.input_tokens;
          stop = ({ tool_use: 'tool_calls', max_tokens: 'length' })[event.delta?.stop_reason] ?? stop; break;
        case 'message_stop': complete = true; break;
      }
    };
    try {
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }); buffer = buffer.replace(/\r\n/g, '\n');
        for (;;) {
          const end = buffer.indexOf('\n\n'); if (end < 0) break;
          const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data && data !== '[DONE]') frame(JSON.parse(data));
        }
      }
      if (!complete) throw new Error('The native account stream ended before completion');
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      emit({}, stop); emit({}, null, usage); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
    } catch (error) {
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ error: { type: 'api_error', message: error.message } }) + '\n\ndata: [DONE]\n\n'));
      controller.close();
    }
  } });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
