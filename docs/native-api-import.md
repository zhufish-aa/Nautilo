# Import API connections from native Harness configuration

Open **Settings → Providers & accounts → API connections → Import from a harness**.
Scanning is local and read-only. Select candidates, then import. No network probe or model
catalog request is made during scanning or import.

## Native formats

| Harness | Files / directories |
| --- | --- |
| Codex | `$CODEX_HOME` or `~/.codex`: `config.toml`, API key in `auth.json`; named model providers and profiles |
| Claude Code | `$CLAUDE_CONFIG_DIR` or `~/.claude`: `settings.json`, `settings.local.json`, `env` API settings |
| Kimi Code | `$KIMI_CODE_HOME` or `~/.kimi-code/config.toml`: providers and models |
| OpenCode | `$OPENCODE_CONFIG`, `$OPENCODE_CONFIG_DIR` or XDG `opencode/opencode.json[c]`; API credentials in XDG data `opencode/auth.json` |
| Pi | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`: `models.json`, `settings.json`, API entries in `auth.json` |
| Oh My Pi | `~/.omp/agent` and selected `OMP_PROFILE` / `PI_PROFILE`: `models.yml`, `config.yml`, read-only API entries in `agent.db` and endpoint metadata in `models.db` |
| Command Code | `~/.commandcode/config.json`, `auth.json` API key |
| Trae Agent | `$TRAE_CONFIG_FILE` or `~/.trae-agent/trae_config.{yaml,yml,json}`: model providers and models |
| DeepSeek Harness | `$DSH_HOME` or `~/.dsh`: profile `cordis.yml` + `cordis.patch.yml` LLM providers; API refs in `.credentials.yaml` |

Nautilo's configured native login directories are also scanned. Supported API transports
are OpenAI Responses, Chat Completions and Anthropic Messages. Provider/model transport
overrides remain separate candidates. Declared models, names, context windows and image
input declarations are copied when present; built-in model catalogs are not bulk-enabled.

## Credential and import behavior

- Preview IPC returns `hasCredential`, never the key. Keys stay in a bounded, ten-minute
  backend scan cache and are encrypted by the existing credential vault on import.
- Environment references (`${NAME}`, `{env:NAME}`, explicit `env_key` / `apiKeyEnv`, and
  Pi environment-name values) are resolved by the daemon. OpenCode `{file:path}` keys
  are read with a 64 KiB limit. Commands and API key helpers are never executed.
- Native OAuth tokens, browser session credentials and Google account tokens are not
  converted into API keys. Add accounts through **Login accounts**.
- Identical protocol + normalized URL + credential values merge their sources and models.
  An already-saved matching connection is marked as existing and is never overwritten.
  Repeating the same import is idempotent. Different keys remain separate connections.
- Missing keys/models are visible in preview. Missing-key candidates are not preselected;
  they can be imported for completion in the normal editor.
- Unreadable files are reported individually. Native files and databases are not modified.

## Code and focused validation

- Shared IPC: `connection.scanNative`, `connection.importNative`; types in
  `packages/schemas/src/connection-import.ts`.
- Production backend: `rust/nautilo-core/src/application/connection_import/`.
- Node daemon counterpart: `packages/core-daemon/src/application/connection-import/`.
- UI: `NativeConnectionImportDialog.tsx`, using the existing dialog, typography and colors.
- Rust: `cargo test -p nautilo-core connection_import::tests`.
- Node: build the core daemon, then run `node --test packages/core-daemon/test/connection-import.test.mjs`.

Custom shell-based key helpers, arbitrary CLI startup arguments, and unsupported native
API transports require manual configuration; scanning does not execute the Harness.
