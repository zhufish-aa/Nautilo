# Session usage and costs

Settings → Usage & costs reads the persisted Nautilo event journal on demand. It does not scan external CLI history folders. Loading is bounded to three sessions at a time; subsequent refreshes use an event cursor. Normal conversation updates also feed the usage view. Only the latest accounting snapshot per scope/key is retained, not another copy of conversation text.

## Accounting contract

`usage.updated` is a replacement snapshot, not a delta:

- `context`: current context footprint only, never added to throughput or cost.
- `turn`: cumulative usage for one CLI execution, keyed by the run ID.
- `session`: cumulative native-thread usage, keyed by native thread identity.
- Missing scope/key: legacy or unsupported accounting, displayed as unavailable rather than guessed.

`inputTokensIncludesCache` distinguishes inclusive Codex inputs from Claude's non-cache inputs. Cache reads and cache writes remain separate. Reasoning tokens are a subset of output, not added again. Negative/nonfinite numbers are ignored. Known zero is preserved; unavailable is rendered as `—`.

Claude result events supply turn snapshots; assistant message usage supplies context only. Codex app-server supplies session snapshots; exec/chat-completions supply turn snapshots. Kimi context usage remains context-only. Other providers without explicit accounting semantics remain unavailable, even when they report a context window.

## Cost semantics

- CLI reported USD: provider accounting values, not proof of a billed payment. A subscribed CLI may report list-price equivalents.
- Equivalent API estimate: user-entered USD-per-million rates captured for each run, not a historical invoice. Every nonzero token category requires a configured rate; zero-priced categories are valid.
- Only complete pricing snapshots saved for the run may estimate historical usage. Current session or connection configuration is never substituted for historical model identity or prices.
- Session snapshots may span model changes, so they are not estimated at the latest model's rates. They retain known tokens and provider-reported cost.
- Missing costs, model identities, currency, or rates are not treated as free usage. Summary coverage discloses priced versus all filtered sessions.
- No daily chart or date-range allocation is inferred from cumulative snapshots. The initial view is explicitly all time.

## Navigation

Providers & accounts is a separate settings section (`section=accounts`) for independent versioned connection, login, model and price configuration. Agent executable configuration remains in Models & agents (`section=agents`). Usage & costs is `section=usage`; `session=<id>` focuses one session. The conversation context indicator links directly to its session's accounting details.

## Tests

- `session-usage.test.mjs`: snapshot replacement, turn/session scopes, legacy/context exclusion, unknown vs zero, cache semantics, reasoning subsets, currencies, complete pricing and mixed-model safeguards.
- `usage-store.test.mjs`: stale replay, refresh coalescing, restart recovery and empty journals.
- Existing orchestration latency/cache tests cover unchanged startup/polling behavior.
- Core adapter and runtime/security tests cover metadata propagation and telemetry redaction in persisted events. Rust parity coverage is included; run cargo tests in the supported toolchain environment.
