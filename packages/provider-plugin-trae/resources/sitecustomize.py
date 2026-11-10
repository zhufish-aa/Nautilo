"""Nautilo's per-process bridge to the installed, unmodified Trae Agent.

Loaded through PYTHONPATH for this invocation only. The CLI still owns tools,
native configuration and its agent loop; this bridge exposes its live events
and checkpoints the native provider message history between invocations.
"""
import os


def install():
    import base64
    import json
    import sys
    import uuid
    from pathlib import Path
    from importlib.metadata import version
    from trae_agent.utils.llm_clients.llm_client import LLMClient
    from trae_agent.tools.base import ToolExecutor

    state_path = Path(os.environ["NAUTILO_TRAE_STATE"])
    session_id = os.environ["NAUTILO_TRAE_SESSION_ID"]
    resume = os.environ.get("NAUTILO_TRAE_RESUME") == "1"
    effort = os.environ.get("NAUTILO_TRAE_EFFORT")
    image_paths = json.loads(os.environ.get("NAUTILO_TRAE_IMAGES", "[]"))
    restored = json.loads(state_path.read_text(encoding="utf-8")) if resume and state_path.is_file() else {}
    active = None
    pending_results = []
    totals = {}
    sequence = 0

    def plain(value):
        if hasattr(value, "model_dump"):
            return plain(value.model_dump(exclude_none=True))
        if isinstance(value, dict):
            return {key: plain(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [plain(item) for item in value]
        return value

    def emit(kind, **payload):
        sys.stdout.write("\n@nautilo-event:" + json.dumps({"kind": kind, **payload}, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def checkpoint():
        if active is None or not hasattr(active.client, "message_history"):
            return
        history = plain(active.client.message_history)
        provider = active.provider.value
        for result in pending_results:
            if provider == "anthropic":
                history.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": result.call_id,
                    "content": result.result or result.error or "", "is_error": not result.success}]})
            else:
                history.append({"role": "tool", "tool_call_id": result.call_id, "content": result.result or result.error or ""})
        state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"provider": provider, "history": history}, ensure_ascii=False), encoding="utf-8")
        temporary.replace(state_path)

    def resumable_history(history, provider):
        # Trae treats task_done as a completion signal without executing it.
        # Interrupted tool calls may also lack a receipt; never replay orphaned calls.
        receipts = set()
        for message in history:
            if provider == "anthropic" and isinstance(message.get("content"), list):
                receipts.update(block.get("tool_use_id") for block in message["content"] if block.get("type") == "tool_result")
            elif message.get("role") == "tool":
                receipts.add(message.get("tool_call_id"))
        result = []
        for original in history:
            message = dict(original)
            if message.get("role") == "assistant":
                if provider == "anthropic" and isinstance(message.get("content"), list):
                    message["content"] = [block for block in message["content"] if block.get("type") != "tool_use" or block.get("id") in receipts]
                    if not message["content"]:
                        continue
                elif message.get("tool_calls"):
                    message["tool_calls"] = [call for call in message["tool_calls"] if call.get("id") in receipts]
                    if not message["tool_calls"]:
                        message.pop("tool_calls")
                        if not message.get("content"):
                            continue
            result.append(message)
        return result

    def add_images(client, anthropic):
        if not getattr(client, "_nautilo_images", None):
            return
        target = next((message for message in reversed(client.message_history) if message.get("role") == "user"), None)
        if target is None:
            raise RuntimeError("Trae image input has no user message")
        text = target.get("content", "")
        content = [{"type": "text", "text": text}] if isinstance(text, str) else list(text)
        for name in client._nautilo_images:
            path = Path(name)
            mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}.get(path.suffix.lower())
            if not mime:
                raise ValueError(f"Unsupported image attachment: {name}")
            data = base64.b64encode(path.read_bytes()).decode("ascii")
            if not data:
                raise ValueError(f"Empty image attachment: {name}")
            content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}} if anthropic
                else {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
        target["content"] = content
        client._nautilo_images = []

    # Preserve the native CLI's existing MCP lifecycle fix.
    if version("trae-agent") == "0.1.0":
        from trae_agent.agent.trae_agent import TraeAgent
        async def close_mcp_transports(self):
            while self.mcp_clients:
                await self.mcp_clients.pop().cleanup("cleanup")
        TraeAgent.cleanup_mcp_clients = close_mcp_transports

    from trae_agent.utils.llm_clients.anthropic_client import AnthropicClient
    anthropic_create = AnthropicClient._create_anthropic_response
    def anthropic_stream(client, model_config, tool_schemas):
        if not getattr(client, "_nautilo_main", False):
            return anthropic_create(client, model_config, tool_schemas)
        add_images(client, True)
        client._nautilo_prefix_length = len(client.message_history)
        kwargs = {"model": model_config.model, "messages": client.message_history, "max_tokens": model_config.max_tokens,
            "system": client.system_message, "tools": tool_schemas,
            "temperature":model_config.temperature, "top_p":model_config.top_p, "top_k":model_config.top_k}
        if effort:
            kwargs["extra_body"] = {"output_config": {"effort": effort}}
        # Each retry owns a fresh item ID; a failed partial response is closed.
        item = "trae-" + uuid.uuid4().hex
        thinking = False
        try:
            with client.client.messages.stream(**kwargs) as stream:
                for event in stream:
                    if event.type != "content_block_delta":
                        continue
                    delta = event.delta
                    if delta.type == "text_delta":
                        emit("message", phase="delta", messageId=item, text=delta.text)
                    elif delta.type == "thinking_delta":
                        thinking = True
                        emit("thinking", phase="delta", messageId=item + ":thinking", text=delta.thinking)
                result = stream.get_final_message()
            client._nautilo_response = result
            emit("message", phase="completed", messageId=item, text="".join(block.text for block in result.content if block.type == "text"))
            return result
        finally:
            if thinking:
                emit("thinking", phase="completed", messageId=item + ":thinking", text="")
    AnthropicClient._create_anthropic_response = anthropic_stream

    from trae_agent.utils.llm_clients.openai_compatible_base import OpenAICompatibleClient
    openai_create = OpenAICompatibleClient._create_response
    def openai_stream(client, model_config, tool_schemas, extra_headers=None):
        if not getattr(client, "_nautilo_main", False):
            return openai_create(client, model_config, tool_schemas, extra_headers)
        from openai.types.chat import ChatCompletion
        add_images(client, False)
        kwargs = {"model": model_config.model, "messages": client.message_history, "stream": True, "stream_options": {"include_usage": True}}
        kwargs["top_p"] = model_config.top_p
        if not any(name in model_config.model for name in ["o3", "o4-mini", "gpt-5"]):
            kwargs["temperature"] = model_config.temperature
        kwargs["max_completion_tokens" if model_config.should_use_max_completion_tokens() else "max_tokens"] = model_config.get_max_tokens_param()
        if tool_schemas:
            kwargs["tools"] = tool_schemas
        if extra_headers:
            kwargs["extra_headers"] = extra_headers
        if effort:
            kwargs["reasoning_effort"] = effort
        item = "trae-" + uuid.uuid4().hex
        text, reasoning, calls, usage, finish, model = "", "", {}, None, "stop", model_config.model
        with client.client.chat.completions.create(**kwargs) as stream:
            for chunk in stream:
                model = chunk.model or model
                if chunk.usage:
                    usage = plain(chunk.usage)
                for choice in chunk.choices:
                    finish = choice.finish_reason or finish
                    delta = choice.delta
                    if delta.content:
                        text += delta.content
                        emit("message", phase="delta", messageId=item, text=delta.content)
                    thought = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                    if isinstance(thought, str):
                        reasoning += thought
                        emit("thinking", phase="delta", messageId=item + ":thinking", text=thought)
                    for call in delta.tool_calls or []:
                        entry = calls.setdefault(call.index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                        if call.id:
                            entry["id"] = call.id
                        if call.function:
                            entry["function"]["name"] += call.function.name or ""
                            entry["function"]["arguments"] += call.function.arguments or ""
        message = {"role": "assistant", "content": text, "tool_calls": [calls[key] for key in sorted(calls)] or None}
        if reasoning:
            message["reasoning_content"] = reasoning
            emit("thinking", phase="completed", messageId=item + ":thinking", text=reasoning)
        emit("message", phase="completed", messageId=item, text=text)
        client._nautilo_response_message = message
        return ChatCompletion.model_validate({"id": item, "object": "chat.completion", "created": 0, "model": model,
            "choices": [{"index": 0, "finish_reason": finish, "message": message}], "usage": usage})
    OpenAICompatibleClient._create_response = openai_stream

    original_chat = LLMClient.chat
    def chat(self, messages, model_config, tools=None, reuse_history=True):
        nonlocal active, sequence
        # Lakeview has its own client; it must not consume/overwrite conversation history.
        if not getattr(self.client, "trajectory_recorder", None):
            return original_chat(self, messages, model_config, tools, reuse_history)
        if active is None:
            active = self
            if restored:
                if restored.get("provider") != self.provider.value:
                    raise RuntimeError("Trae session provider changed; start a new session for the new protocol")
                self.client.message_history = resumable_history(restored["history"], self.provider.value)
            self.client._nautilo_images = image_paths
            self.client._nautilo_main = True
        pending_results.clear()
        sequence += 1
        response = original_chat(self, messages, model_config, tools, reuse_history)
        if self.provider.value == "anthropic" and hasattr(self.client, "_nautilo_response"):
            self.client.message_history = self.client.message_history[:self.client._nautilo_prefix_length] + [
                {"role": "assistant", "content": plain(self.client._nautilo_response.content)}]
        elif hasattr(self.client, "_nautilo_response_message"):
            self.client.message_history[-1] = self.client._nautilo_response_message
        checkpoint()
        if response.usage:
            mapping = {"inputTokens": "input_tokens", "outputTokens": "output_tokens", "cachedInputTokens": "cache_read_input_tokens",
                "cacheCreationInputTokens": "cache_creation_input_tokens", "reasoningOutputTokens": "reasoning_tokens"}
            values = {key: getattr(response.usage, source, None) for key, source in mapping.items()}
            emit("usage", usageScope="context", inputTokensIncludesCache=False,
                contextUsed=sum(values[key] or 0 for key in ["inputTokens", "cachedInputTokens", "cacheCreationInputTokens"]), **values)
            for key, value in values.items():
                totals[key] = totals.get(key, 0) + value if value is not None and totals.get(key, 0) is not None else None
            emit("usage", usageScope="turn", inputTokensIncludesCache=False, **totals)
        return response
    LLMClient.chat = chat

    original_execute = ToolExecutor.execute_tool_call
    async def execute(self, call):
        emit("tool", phase="started", callId=call.call_id, name=call.name, input=call.arguments)
        try:
            result = await original_execute(self, call)
            pending_results.append(result)
            checkpoint()
            emit("tool", phase="completed", callId=call.call_id, name=call.name, input=call.arguments,
                success=result.success, output=result.result or result.error or "")
            return result
        except BaseException as error:
            emit("tool", phase="completed", callId=call.call_id, name=call.name, success=False, output=str(error))
            raise
    ToolExecutor.execute_tool_call = execute
    emit("nautilo_ready")
    emit("session", providerSessionId=session_id)


if os.environ.pop("NAUTILO_TRAE_BRIDGE", None) == "1":
    try:
        install()
    except Exception as error:
        # sitecustomize normally swallows import errors and continues. Failing
        # explicitly prevents a new untracked session from looking successful.
        import sys
        sys.stderr.write(f"Nautilo Trae bridge failed to initialize: {error}\n")
        sys.stderr.flush()
        os._exit(1)
