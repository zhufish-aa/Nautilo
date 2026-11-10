# Conversation identity and per-request connection choices

The Agent chosen before a conversation starts is fixed for that conversation. Its label appears immediately to the right of the title. Existing and team-member conversations resolve their bound Agent; the composer does not offer an Agent rebind action.

The composer exposes only model and reasoning-effort buttons. The model menu includes compatible account/API connections. Model IDs and effort choices come from the actual selected connection's saved model list or the legacy Agent catalog; free-text/unverified choices are not invented. Team member defaults remain available for legacy member-routed sessions.

## Switching account/provider

- Idle conversations can change connection for the next request, including explicitly returning to their legacy Agent configuration.
- The UI asks for confirmation naming the destination connection and API endpoint (or official login harness). It explains the saved chat text and latest eight artifact names/paths that will be shared with that destination, including data previously sent elsewhere.
- Native reasoning/cache, tool events and old image binaries do not migrate. Users must reattach required images. History remains visible; this is not a lossless transfer of provider-native context. Oversized text is rejected rather than silently truncated.
- The confirmation flag is sent only with the approved change. Failed persistence retains the old connection and leaves confirmation available to retry. The server-returned revision is authoritative.
- Active or queued requests block changes. Sends wait for pending configuration writes. Previously recorded runs and their pricing snapshots keep their original identity.
- Bound connection revisions are read explicitly, not silently replaced by current heads. A newer revision of the same connection has an explicit “Update to connection vN” action and the same confirmation.
- Supported choices mirror the backend's existing protocol constraints. Codex/Anthropic translation is not advertised without a proven enabled capability. Missing/failed connection reads do not fall back to another provider.

## Tests

`session-connections.test.mjs` verifies compatibility filtering. `session-controls-dom.cjs` bundles the actual component and verifies Agent immutability, compact controls, confirmation/cancel/failure/retry, server revision capture, source-specific models, same-ID revision update availability, running-state lock, and team-member resolution using an in-memory bridge. `navigation-dom.cjs` covers the full App including settings and first send. These are DOM tests, not live provider/WebView verification.
