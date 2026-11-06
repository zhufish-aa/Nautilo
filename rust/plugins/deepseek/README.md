# DeepSeek Harness provider

Native Rust provider for the official `@deepseek-ai/dsh` CLI. Tested with
`0.2.1-rc.3` on Windows. Build through the Rust workspace and install the folder
containing `agenthub-plugin.json` and `agenthub-plugin-deepseek.exe`.

The integration starts the native Web profile with `--no-open` on an ephemeral
loopback port. A Nautilo-owned Cordis transport extension calls the existing
Session Controller and observes public Agent/Session events. The native runtime
continues to own its agent loop, tools, plugins, permissions, presets and logs.
It is deliberately not based on the SDK-only profile: the Web preset registry
is where the user's standard, PTC, minimal, creative and custom modes live.

## Runtime lifetime

Consecutive turns reuse the same native process and restored session. Replies
finish the turn without shutting down the Web profile or reconnecting MCP servers.
Idle sessions are retained without a fixed idle-time eviction. Connection, model,
workspace, environment, tools or resource changes invalidate that session's runtime.
Reasoning effort and permissions are applied on every turn. Cancellation and
failures retire the process; the next message resumes the persisted session.
Application/plugin shutdown also closes idle processes. Run time, idle time and
output limits are measured separately for each turn. Set `NAUTILO_DSH_TIMING=1`
to log startup/reuse timings and native process IDs to plugin stderr (no prompts,
keys or connection details).

## Conversation modes

`provider.modes` reads `agentPresets.list()` and `defaultId` from the actual
runtime. The renderer does not enumerate selectable presets itself. It retains
custom names, order and native activation errors, with an explicit refresh.
The selected `agentMode` is persisted on the Nautilo session and sent to native
session creation. Native resume retains the original session/preset. As required
by DeepSeek's native API, an already-started conversation does not silently
switch its composition: choose a different mode in a new conversation.

## Connections and resources

The selected API connection is added to the existing pi-ai adapter with Cordis'
`noSave` runtime update. Other native provider routes are retained; neither the
profile nor native credential files are overwritten. The generated overlay
stores only a fresh environment credential reference, not its key.
Native resources remain loaded. Enabled Nautilo skills and MCP servers are
additional providers; host delegation tools use the SDK's reverse tool channel.

## Events and control

- Live assistant text/reasoning uses `agent/assistant-stream`, not delayed
  replay of the final assistant message.
- Durable tool calls/results retain their call IDs. Child events are scoped to
  their native child dispatch, and unrelated native sessions are ignored.
- PTC nested dispatch start/result events update their owning `run_code` batch.
  Incremental patches retain dispatch ancestry, actual tool arguments, results
  and status without resending or truncating the entire accumulated tool tree.
  Batch completion follows the native result; DSML returned as prose is reported
  as an unexecuted upstream tool call instead of a successful run.
- Per-model image input declarations are passed to the native model adapter.
- Per-step native usage is deduplicated into turn totals. Context capacity is
  taken from native `request/context` when supplied.
- Approvals and structured questions wait for the Nautilo interaction response.
- Steering waits through native startup and acknowledges actual acceptance.
  A finishing turn closes admission before process teardown.
- Cancellation calls the native cancel path before the bounded process cleanup.
- Manual compaction is advertised only when the selected preset exposes it.
- An ordered stdout barrier drains events before the completed run is emitted.

## Validation

`tests/native-smoke.mjs` uses the installed official CLI, an isolated temporary
DSH home/workspace and a local fake Chat Completions SSE endpoint. It verifies
two-turn resume, live text/reasoning, usage, reasoning effort, native file tools,
Nautilo reverse tools, startup steering, dynamic custom-mode discovery and the
selected custom persona reaching the model request, PTC nested dispatches,
native image reading and malformed DSML failure handling. It does not use real API
credentials or modify the user's DeepSeek configuration.

Set `NAUTILO_DEEPSEEK_TEST_PLUGIN` to the compiled plugin and
`NAUTILO_DEEPSEEK_TEST_CLI` to the official CLI launcher, then run:

```sh
node rust/plugins/deepseek/tests/native-smoke.mjs
```

Official interfaces:
[CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md),
[source repository](https://github.com/deepseek-ai/deepseek-harness).
