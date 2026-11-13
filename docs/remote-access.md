# Desktop remote access

The production Electron application hosts an authenticated QUIC endpoint in the Rust daemon. The settings entry is **远程连接 / Remote access**. The native Android companion is in `apps/mobile`; see its README for the APK build and pairing instructions.

## Connection model

- Iroh 1.4.1 provides authenticated endpoint identities, TLS-encrypted QUIC streams, NAT traversal, network-change handling and encrypted relay fallback.
- Automatic mode uses Iroh's public relay and address discovery services. Reachability still depends on those services and the user's network. Their availability is outside Nautilo's control.
- Custom mode uses the configured HTTPS Iroh relays. Public signed address discovery remains enabled to support reconnecting after addresses change. The relay must implement the Iroh protocol. A TURN URL is a different protocol.
- Direct-only mode (`local`) disables public relay, discovery and automatic router port mapping. The client connects using the known IP addresses in the pairing invitation. LAN use is its primary scenario; reachable IPv6 addresses also support direct connections.
- Endpoint private keys are encrypted using the existing desktop credential vault. Only endpoint public keys appear in the interface and pairing invitations.
- Phone clients pin the desktop endpoint ID from the QR invitation. Iroh authenticates the phone's endpoint ID during its TLS handshake. Returning devices must keep their private key in platform secure storage.

The computer must remain powered on and online. Enabling remote access keeps Electron and the Rust daemon running in the system tray after the main window closes. The optional wake lock prevents idle application suspension while remote access is enabled. Explicitly quitting Nautilo stops the endpoint. Existing work is independent of a phone's network connection.

## Pairing

1. Enable remote access and choose **配对新设备**.
2. The invitation uses `nautilo://pair#<base64url-json>`. Decode the fragment as UTF-8 JSON.
3. Read `v`, `transport`, `alpn`, `name`, `endpoint`, `token` and `expiresAt`. `endpoint` is the serialized Iroh `EndpointAddr`. Version is `1` and ALPN is `nautilo/remote/1`.
4. Connect with the desktop's pinned endpoint ID, then call `pair` with the token and phone's display name. The token is valid for five minutes and can admit one pending device.
5. Both devices display the six-digit verification code. The desktop user confirms the matching code. This is an owner's companion: pairing grants control of all projects, including projects created later. There is no per-project grant or read-only selector.
6. Poll `pair.status` until `paired`. Pending confirmation expires after two minutes. Closing or regenerating the invitation cancels unapproved requests.

The verification code is the first four bytes, big-endian, of SHA-256 over `<phone-endpoint-id>:<token>`, modulo 1,000,000, zero-padded to six digits. The phone can independently verify this code. The token stays inside the encrypted connection. Neither relay traffic nor desktop audit records contain the plaintext token.

## Wire protocol

Each request uses a new bidirectional QUIC stream. Write one UTF-8 JSON document, finish the sending side, then read one JSON response to EOF. Multiple streams support long polling alongside commands.

```json
{"v":1,"id":"0dd02c68-3eab-4bd0-8197-f1d51f7e41b8","method":"hello","params":{}}
```

```json
{"v":1,"id":"0dd02c68-3eab-4bd0-8197-f1d51f7e41b8","ok":true,"data":{"protocol":1,"epoch":"…","device":{},"name":"Desktop","capabilities":[]}}
```

Failures have `ok:false` and `error:{code,message}`. Use a fresh UUID for each new request. Resending an uncertain mutation uses its original UUID and identical parameters.

| Method | Parameters | Result |
| --- | --- | --- |
| `pair` | `token`, `name` | `awaitingApproval` and verification `code` |
| `pair.status` | empty | `paired`, `awaitingApproval` or `expired` |
| `hello` | empty | version, database epoch, grant and capabilities |
| `projects.list` | empty | all project IDs, names and working directories |
| `project.browse` | optional absolute `path`, `offset` | drive roots / subdirectories, parent and pagination cursor |
| `project.create` | existing `rootPath`, optional `name`, optional new child `folderName` | add an existing directory or create a child directory and register the project |
| `session.options` | empty | enabled Harness instances and enabled API/account connections, without credentials or executable/environment settings |
| `session.catalog` | `agentInstanceId`, optional `connectionId` | selectable models and reasoning efforts |
| `sessions.list` | `projectId`, optional `offset`, `limit` | session summaries, `total`, `nextOffset` |
| `session.history` | `sessionId`, optional `before`, `limit` | chronological `items` with `value` and `order`, older-page cursor, database `epoch` and latest event `sequence` |
| `events.wait` | `sessionId`, `epoch`, `afterSequence`, optional `limit` | up to 200 events, `lastSequence`, `hasMore`, waits up to 20 seconds |
| `session.create` | `projectId`, `agentInstanceId`, optional `connectionId`, `model`, `reasoningEffort`, `title`; or an existing template `sessionId` | independently create a session; the desktop pins the chosen connection revision |
| `session.details` | `sessionId` | current configuration, Harness identity and team members |
| `session.models` | `sessionId` | current connection's model catalog |
| `session.configure` | `sessionId`, `model`, `reasoningEffort` | update using the normal desktop session service |
| `session.workspace` | `sessionId` | observed native file changes, patches / before-and-after content, bounded to 100 files / 2 MiB |
| `session.send` | `sessionId`, `text` | desktop run acceptance, run ID and stable message ID |
| `session.followUp` | `sessionId`, `text`, `mode` of `steer` or `queue` | native follow-up acceptance |
| `run.list` | `sessionId` | runs for this session |
| `run.cancel` | `runId` | cancellation receipt |
| `interaction.list` | `sessionId` | pending native questions |
| `interaction.respond` | `sessionId`, `interactionId`, `outcome`, optional `optionId`, `answers` | native interaction result |
| `approval.list` | `sessionId` | pending approvals for this session |
| `approval.resolve` | `sessionId`, `approvalId`, `decision` | approve/reject with one-time scope |

The desktop constructs allowlisted mutation inputs and calls its existing application services. The phone can choose configured accounts for new sessions; it does not copy their secrets. Arbitrary IPC, credential export, raw terminal commands and global policy changes have no remote route. Native Harness permission prompts remain native interactions and can be answered on the phone.

## Reconnect and delivery

Save the desktop endpoint ID and relay hints after pairing. Reconnect with the same phone key. Iroh resolves the desktop's current address in automatic/custom modes. A mobile client should use capped exponential reconnect delays with jitter and reconnect promptly when the OS announces a network change.

Call `hello` after reconnecting. Retain the last fully applied event sequence for each session and replay using `events.wait`. Apply events in sequence order, deduplicate `eventId` and advance the cursor after processing the page. Fetch further pages while `hasMore` is true. If the database epoch differs or the host returns `CURSOR_RESET_REQUIRED`, reload history and initialize a fresh cursor.

For initial hydration, load the newest history page first, remember its `sequence`, then start event polling from that sequence. Older history pages use the returned `before` object (`createdAt`, `ordinal`); loading older messages must not replace the live event cursor. Sort messages by `order.createdAt` followed by `order.ordinal`, matching the desktop's history projection. Message IDs remain stable across history and event updates.

`session.history.activity` includes recent thinking, tool and message events at the same snapshot cursor, so opening a session during generation does not lose its current text. The Rust event repository coalesces `_delta` events into **cumulative text snapshots**. Replace the current stream text; do not append the cumulative value. A final `agent.message` identifies its previous stream using `providerMessageId`, and its persisted message ID replaces that provisional stream. Keep a stream's original position while its text grows.

Mutations reserve their `(device identity, request UUID)` in SQLite before execution. The command fingerprint covers the method and parameters. Completed responses survive reconnection and daemon restart. Reusing a UUID with changed input returns `REQUEST_ID_CONFLICT`. A command reserved immediately before a crash may return `COMMAND_OUTCOME_PENDING`. The client must inspect history/run state to resolve it before offering a new command. Remote requests continue to settle on the desktop when a network stream closes.

For `session.send` and `session.followUp`, the returned `messageId` identifies the optimistic message in desktop history and events. It is namespaced by device identity and request UUID, preventing collisions with other clients' messages. It is the UUID representation of the first sixteen bytes of SHA-256 over `nautilo-remote:<phone-endpoint-id>:<request-uuid>`.

## Limits and lifecycle

- 32 trusted devices, 32 concurrent incoming connections, 8 request streams per connection.
- Requests up to 256 KiB and responses up to 8 MiB. History accepts 1–100 messages per page, event replay accepts 1–200 events. `RESPONSE_TOO_LARGE` asks the client to reduce its page size.
- Per-connection limit of 100 requests in ten seconds. Keep long-poll responses open instead of busy polling.
- Handshake and request-read deadlines are ten seconds. Response writes have a fifteen-second deadline. Unapproved connections expire after three minutes.
- Twenty failed token checks exhaust an invitation. Token verification uses constant-time HMAC verification.
- Revocation removes the persisted trust record and immediately closes the current connection. Every command rechecks the paired device identity; long polls recheck it before returning data. No project grant needs updating when a project is added.
- Pairing, device changes, revocation and mutations write bounded metadata-only audit records in `remote_audit`. Mutation receipt records remain durable in `remote_commands`.
- The Rust host retries endpoint creation after a startup failure. Iroh handles relay reconnect and path changes for a running endpoint. Network status reports the actual home relay state and selected connection path.

The legacy Node daemon returns `supported:false` for remote status and `REMOTE_BACKEND_REQUIRED` for management mutations. The production Rust backend implements the transport.

## Validation

Focused Rust tests use real encrypted QUIC endpoints and a temporary SQLite database. They cover pending pairing, bad/expired tokens, desktop approval, owner access, duplicate/concurrent mutation IDs, reconnect, revocation, cursor replay, durable command reservations, sanitized creation options, pinned account revisions, and Unicode directory creation. They use a stub application handler for message dispatch so these unit tests incur no model calls.

Run from the Rust workspace with the repository's configured Rust environment.

```sh
cargo test -p nautilo-core runtime::remote::tests
```

The Windows GNU build disables automatic DLL symbol export because Iroh ships an additional C-compatible library target. Rust consumers link its Rust library directly. This avoids PE export ordinal overflow in debug builds.

Android instrumentation has paired the actual JNI Iroh endpoint to the Windows Rust host, read real sessions and workspace changes, and reconnected using the stored identity. Physical-phone UX, carrier NAT combinations, actual internet relay failover, macOS and Linux packaging still require device/platform validation.
