# Codex concurrent sessions

Nautilo uses a separate Codex app-server subprocess for each active local session. Sessions sharing an Agent instance can run concurrently, including the main agent and delegated child sessions. A turn's output, tools, approvals and cancellation stay with its leased subprocess. Turns in the **same session** remain ordered to preserve one conversation context.

## Limits

- By default, Nautilo does not impose a fixed active-session concurrency limit. This does not remove OS memory/process limits, account quotas or provider rate limits. Launch/resource failures are reported rather than silently counted as running work.
- Agent settings offer an optional **Concurrency limit**. Leave it blank for unlimited. An explicit positive integer applies to that instance; excess conversation work queues. Clearing it removes the saved limit. Internal short-lived native-search helpers do not occupy a conversation slot, so a parent turn cannot deadlock while awaiting its own helper; their existing completion/timeout cleanup remains in effect.
- Team members also have an optional task limit. New members default to unlimited. Existing explicitly stored limits remain unchanged and can be cleared in member settings.
- Task dependencies still control execution order. Continuing a specified existing session does not create a separate parallel context.

Idle subprocesses are reclaimed. Fresh processes sharing a not-yet-initialized Codex HOME coordinate first initialization; after successful initialization, independent processes need not serialize startup. Different HOME directories do not share that initialization gate. Nautilo does not copy account credentials into new HOME directories.

## Validation scope

Production TypeScript adapters are exercised using local fake Codex stdio subprocesses, covering overlapping turns, optional limits, cancellation, response routing and lifecycle cleanup. Real installed Codex CLI probes use a fresh isolated HOME with no account or model requests. They confirm parallel initialize after warm-up, not real-model parallel throughput.

The current validation environment cannot compile Rust and blocks deeper real thread creation at the sandbox helper's socket-directory check. Native Tauri/Rust behavior and real-model concurrency require target-platform validation before treating the feature as verified there. The older TypeScript official-search worker cache is separate from the new conversation pool: a search already in progress may finish or time out before shutdown completes, and cached search workers retain their existing idle timeout. Immediate cleanup of those older search workers is not part of this validation. Detailed test results and limitations accompany the source delivery.
