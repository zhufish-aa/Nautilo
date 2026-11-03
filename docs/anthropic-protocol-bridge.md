# Experimental Codex → Anthropic bridge

The Rust/Tauri adapter includes an experimental Responses-to-Messages conversion
path. **It is disabled by default and has not been compiled or integration-tested
in the implementation environment (no Rust toolchain was available).** A source
review or passing TypeScript tests is not verification of this Rust path.

## Activation

The invocation must select Codex with `providerOptions.wireApi = "anthropic"`,
a configured Anthropic-compatible base URL and an API key. Rust additionally
requires `NAUTILO_EXPERIMENTAL_ANTHROPIC_BRIDGE=1` in the agent or daemon environment.
Without the gate it returns an actionable error; it does not fall back to another
protocol or provider. Do not enable this gate in release defaults until the Rust
build, local fixture tests and actual Codex tool-loop tests pass.

The application launches its real Codex app-server against a per-run loopback
endpoint. The remote receives Anthropic Messages requests. Codex's own config is
not edited. Cancellation closes the proxy and active requests. The Electron/Node
implementation is separate and must be verified independently.

## Initial supported subset

- Streaming text, complete text-only history, system/developer instructions.
- Function tools and results, plus the existing namespaced-tool mapping.
- Custom tools wrapped in an `input` string object. Grammar descriptions are
  retained as descriptions, **not enforced by Anthropic**.
- Incremental text/function arguments, stable output indices, token usage
  (including cached input), completion and max-token incomplete status.
- Explicit failure on malformed, truncated, unknown, or error streams.

Images/audio/files, hosted tools (web search/image generation/computer/file
search), structured output, previous-response IDs, background responses and
reasoning/thinking conversion are unsupported and rejected rather than discarded.
Use a new text-only session when switching from a history with unsupported items.
An unset reasoning effort becomes `none` for this bridge. An explicit non-`none`
effort is rejected. The default output budget is 4096 tokens unless the incoming
request supplies `max_output_tokens`; provider/model-specific limits still apply.

## Security boundaries

The listener binds to `127.0.0.1` on an ephemeral port with an unpredictable
per-run path capability, no generic forwarding endpoint and no CORS grants.
Only the configured provider URL is used. Incoming authorization is **not** sent
to the Anthropic upstream. The key is selected from the invocation environment
(`ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`, `CODEX_API_KEY`, `AGENTHUB_API_KEY`).
Ensure the invocation environment contains the selected profile's credentials,
not credentials inherited from another profile. The upstream receives `x-api-key`
and a fixed `anthropic-version`. Upstream API-key environment variables are removed
from the inner Codex invocation and replaced with a throwaway local key. Redirects are disabled. HTTPS is required except
for literal loopback fixture servers (not DNS names such as `localhost`). URL credentials, query strings and fragments are
rejected. Error responses do not echo remote bodies or credentials.

Request/event sizes, concurrent connections and request durations are bounded.
The lightweight local HTTP endpoint accepts Content-Length request bodies, not
chunked uploads. There is no automatic retry of a partially streamed generation.

## Verification before enabling

On a host with the repository's Rust toolchain, run the normal workspace checks
and at minimum `cargo test -p nautilo-core anthropic` from `rust/`. Linux CI must
override the repository's Windows target/toolchain explicitly, for example
`cargo +stable test --target x86_64-unknown-linux-gnu -p nautilo-core anthropic`.
Fixtures cover request mapping, loss guards, endpoint validation, split UTF-8 SSE,
mixed text/tool indices, token usage, failure states, local capability checks,
upstream credential isolation and downstream-disconnect cancellation.
Then verify a real Codex text turn, multi-turn tool call/result, custom tool call,
cancellation, model selection and unsupported-feature errors against an authorized
test provider. No live provider credentials or billable calls were used here.

## References

The design was checked against [Anthropic streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming)
and the [CC Switch routing architecture](https://github.com/farion1231/cc-switch).
CC Switch is [MIT licensed](https://github.com/farion1231/cc-switch/blob/main/LICENSE).
This bridge was implemented independently in Nautilo; no CC Switch source was
copied or vendored. It does not claim CC Switch's broader feature coverage.

## Existing Chat and official search hardening

The same change also hardens the Rust Responses-to-Chat proxy: configured
credentials only, sanitized upstream failures, no redirects, HTTPS except
literal loopback, child key isolation, and downstream-disconnect cancellation.
The official Responses web-search executor applies that endpoint policy,
connection/overall timeouts, an 8 MiB incremental response limit and sanitized
errors. Anthropic targets are rejected for native web search before routing.
These Rust changes and their additional security fixtures remain uncompiled and
unexecuted in this environment. Run the complete Rust test suite, not only the
Anthropic-filtered tests, before release.
