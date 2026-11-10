# Native CLI resources

Nautilo adds its configured MCP servers and skills to a CLI's own resources.
Adding an API connection must not turn off native plugins, Apps, skills,
session persistence, or normal startup behavior.

## Reference

The CC Switch implementation was reviewed at commit
`98777515d512519209510bce6352ae1984988c81`:

- [MCP service](https://github.com/farion1231/cc-switch/blob/98777515d512519209510bce6352ae1984988c81/src-tauri/src/services/mcp.rs)
- [Oh My Pi MCP](https://github.com/farion1231/cc-switch/blob/98777515d512519209510bce6352ae1984988c81/src-tauri/src/mcp/omp.rs)
- [Kimi MCP](https://github.com/farion1231/cc-switch/blob/98777515d512519209510bce6352ae1984988c81/src-tauri/src/mcp/kimi.rs)
- [Skills](https://github.com/farion1231/cc-switch/blob/98777515d512519209510bce6352ae1984988c81/src-tauri/src/services/skill.rs)

CC Switch manages per-application native configuration entries. It imports
existing entries, preserves native options, and tracks ownership when removing
managed resources. Skills retain their source and full resource directory;
they are deployed to the selected applications, with link/copy options.

Nautilo uses invocation overlays where available because simultaneous
conversations can bind different API connections. The invariant is the same:
preserve native entries and add selected managed entries without replacing
the whole native configuration.

## Invocation behavior

| Harness | Native resources and Nautilo additions |
| --- | --- |
| Codex | The selected Codex profile loads its own Apps/plugins/MCP. Additional MCP settings are invocation scoped. Never add `--disable apps`. Connected Apps must be authorized by that selected account. |
| Claude Code | Keep native configuration and discovery. Additional MCP uses `--mcp-config`; do not add `--strict-mcp-config`. |
| Oh My Pi | Keep the native agent directory and its plugins/MCP/skills/settings. Add the selected model through `registerProvider` and managed MCP/skills through an additional native extension package. Existing Nautilo native session directories remain stable. |
| Pi | Keep native discovery, persistence and startup behavior. The existing additive extension registers the selected API and managed MCP/skills. Offline/ephemeral probes are separate from normal turns. |
| OpenCode | Use `OPENCODE_CONFIG_CONTENT` as an additive provider/MCP overlay. Never temporarily rewrite `.opencode/opencode.json`. |
| Kimi Code | Its API profile inherits native non-model preferences, MCP and complete skill resources, then binds the selected model/provider. Each turn starts from the native MCP baseline before adding managed entries. |
| Command Code | The API profile inherits native MCP/settings/skills/mod resources. Only the selected BYOK provider is written to its provider file. Account auth is not copied or substituted. |
| Trae Agent | Read the user's YAML configuration, preserve tool choices and MCP settings, and override the selected inference binding. Add managed MCP entries to its native server and allow lists. This path is the official open-source `trae-agent`. |

Trae Agent 0.1.0 closes multiple MCP transports in opening order, which can
cancel an otherwise completed run. For a local Python installation, the
adapter's small launcher closes those transports in reverse order. All MCP
servers remain active, the installed CLI files are untouched, and the
launcher only adjusts that known version's cleanup method.

## Skills and ownership

Managed directory skills are synchronized to Claude Code, Codex, Kimi Code,
Pi, Oh My Pi, OpenCode, and Command Code. Imported bundles retain scripts,
references and other assets. Trae Agent has no equivalent documented native
skill-directory interface in this integration; do not invent one.

Only replace a skill definition carrying the marker for that exact Nautilo
capability. A user-owned skill or a different capability with the same slug
must remain intact. Inherited resource manifests remove only unchanged
copies that Nautilo created; they never remove the source profile's files.

Login profiles remain distinct identities. Do not copy auth files, change a
conversation's account, or enable a plugin the user disabled to make a test
pass.

## Native Codex installation and authorization

App-server MCP elicitation requests are forwarded to the conversation's
interaction cards, including the extended-form capability. A native plugin
suggestion requires an explicit installation decision; it is not a completed
installation. Approved suggestions use `plugin/install` on that same native
app-server and account. Provider-supplied HTTPS authorization links open in the
system browser. Opening a link does not answer the pending request.

For remote marketplaces the native `plugin/install.pluginName` field carries
the catalog's `remotePluginId`, not the display name or the slug from the
`name@marketplace` reference. Use elicitation metadata first, and resolve the
native catalog detail when it omits this ID; never send a guessed identifier.

After the user completes authorization, `app/installed` refreshes the selected
thread's runtime snapshot. The adapter accepts the native request only after
every required connector is enabled and callable. Cancellation never installs
a plugin. Installation errors remain visible instead of becoming an invisible
pending confirmation. The adapter never borrows another profile's credentials.

## Targeted regression checks

`packages/core-daemon/test/native-config-merge.test.mjs` verifies configuration
and asset preservation, selected API binding and Pi's normal startup flags.
The native Rust SDK has matching inheritance and MCP merge tests.

`NAUTILO_NATIVE_RESOURCES=1` enables local native-plus-managed MCP fixtures in
`apps/desktop/test/native-connection-smoke.mjs`. The test uses isolated native
homes and a local model endpoint, without user accounts or paid API requests.
