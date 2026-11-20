# Conversation identity and per-request connection choices

The Agent chosen before a conversation starts is fixed for that conversation. Its label appears immediately to the right of the title. Existing and team-member conversations resolve their bound Agent; the composer does not offer an Agent rebind action.

The composer exposes only model and reasoning-effort buttons. The model menu includes compatible account/API connections. Model IDs and effort choices come from the actual selected connection's saved model list or the legacy Agent catalog; free-text/unverified choices are not invented. Team member defaults remain available for legacy member-routed sessions.

## Switching account/provider

- In the desktop composer, choosing a connection selects where the next message will go, including when a turn is active or the user returns to the native Agent configuration. The menu explains that continuing this chat shares saved text and recent artifact names/paths with the selected destination. Sending applies the choice without a separate dialog.
- Native reasoning/cache, tool events and old image binaries do not migrate. Users must reattach required images. History remains visible; this is not a lossless transfer of provider-native context. Oversized text is rejected rather than silently truncated.
- The approval flag is sent only when submitting a message under a user-selected new connection. Failed persistence retains the current connection and the composer draft. The server-returned revision is authoritative.
- Active and previously queued requests keep their saved configuration. A draft targeting the new connection can be edited during the turn and sent once those requests finish. Previously recorded runs and their pricing snapshots keep their original identity.
- Bound connection revisions are read explicitly. The “Update to vN” action selects the newer revision for the next message.
- Supported choices mirror the backend's existing protocol constraints. Codex/Anthropic translation is not advertised without a proven enabled capability. Missing/failed connection reads do not fall back to another provider.

## Tests

`session-connections.test.mjs` verifies compatibility filtering. `conversation-connection-flow.test.mjs` exercises the composer and covers native discovery, pinned revisions, selecting a different account during a turn, failure/retry, and the next send reaching that account in the same chat. `session-controls-dom.cjs` covers Agent identity, choosing the next model and connection revision, and team-member resolution. These tests use an in-memory bridge.
