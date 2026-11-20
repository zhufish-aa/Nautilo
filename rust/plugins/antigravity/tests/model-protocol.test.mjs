import test from 'node:test';
import assert from 'node:assert/strict';
import { fromChat, toChat } from '../resources/model-gateway/protocol.mjs';

test('caller roles, images and historical tool results survive the Messages conversion', () => {
  const request = fromChat({ model: 'gemini-3.8-flash', max_completion_tokens: 1234,
    messages: [
      { role: 'system', content: 'Caller policy' },
      { role: 'developer', content: [{ type: 'text', text: 'Additional policy' }] },
      { role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,REAL_IMAGE' } }] },
      { role: 'assistant', tool_calls: [{ id: 'long/id.with punctuation', function: { name: 'Read', arguments: '{"path":"你好"}' } }] },
      { role: 'tool', tool_call_id: 'long/id.with punctuation', content: 'ACTUAL_RESULT' },
    ], tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'Read' } },
  });
  assert.deepEqual(request.system.map(block => block.text), ['Caller policy', 'Additional policy']);
  assert.equal(request.messages[0].content[1].source.data, 'REAL_IMAGE');
  assert.equal(request.messages[1].role, 'assistant');
  assert.equal(request.messages[1].content[0].id, request.messages[2].content[0].tool_use_id);
  assert.deepEqual(request.messages[1].content[0].input, { path: '你好' });
  assert.equal(request.messages[2].content[0].content[0].text, 'ACTUAL_RESULT');
  assert.deepEqual(request.tool_choice, { type: 'tool', name: 'Read' });
  assert.equal(request.max_tokens, 1234);
});

function response(events) {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const frames = async reply => (await reply.text()).split('\n\n').filter(packet => packet.startsWith('data: ') && packet !== 'data: [DONE]').map(packet => JSON.parse(packet.slice(6)));

test('fragmented native streams preserve text, thinking, parallel tools and usage', async () => {
  const reply = toChat(response([
    { type: 'message_start', message: { usage: { input_tokens: 9 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '你好' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '思考' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-a', name: 'Read', input: {} } },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call-b', name: 'Other', input: { actual: true } } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"中文"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]), { model: 'gemini-3.8-flash' });
  const output = await frames(reply);
  assert.equal(output.map(frame => frame.choices[0]?.delta?.content ?? '').join(''), '你好 world');
  assert.equal(output.map(frame => frame.choices[0]?.delta?.reasoning_content ?? '').join(''), '思考');
  const calls = output.flatMap(frame => frame.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(calls.filter(call => call.id).length, 2);
  assert.equal(calls.filter(call => call.index === 0).map(call => call.function.arguments).join(''), '{"path":"中文"}');
  assert.equal(calls.filter(call => call.index === 1).map(call => call.function.arguments).join(''), '{"actual":true}');
  assert.equal(output.at(-2).choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(output.at(-1).usage, { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 });
});

test('native errors and incomplete streams are explicit errors, never successful stops', async () => {
  for (const events of [[{ type: 'error', error: { message: 'Real provider rejection' } }], [{ type: 'message_start', message: {} }]]) {
    const output = await frames(toChat(response(events), { model: 'fixture' }));
    assert.ok(output.at(-1).error?.message);
    assert.ok(!output.some(frame => frame.choices?.[0]?.finish_reason));
  }
  const refused = new Response('{"error":{"message":"native quota"}}', { status: 429 });
  assert.equal(toChat(refused, {}).status, 429);
});
