# Login accounts

In Settings → Login accounts, choose **Add account**, then **Codex** or **Claude Code**. Nautilo checks the official CLI, automatically allocates a fresh private profile directory, and starts `codex login` or `claude auth login`. The CLI handles browser authorization. No directory, API key, endpoint, or preliminary Save step is required.

Nautilo waits for the login process to exit successfully before creating an independent login connection. It then selects that connection in the UI; the native shell attempts to bring the app forward. Failed, cancelled, missing-CLI and interrupted flows never add a successful-looking account. A completed CLI process is not a continuing token-validity or account-identity check. No real sign-in was performed during development validation.

Each added account gets a unique app-managed directory under application data. Unix directories require current-user ownership and private permissions. Windows verifies ownership, rejects reparse points and sets a protected current-user-only ACL before login; native Windows validation is still required. Credentials remain under official CLI control, never copied or displayed by Nautilo. Storage location is available as read-only advanced information.

Supported selectors:
- Codex: `CODEX_HOME`.
- Claude Code: `CLAUDE_CONFIG_DIR` for claude.ai accounts, plus a separate `ANTHROPIC_CONFIG_DIR` under each account to prevent global default/active federation profiles from overriding the selected login. These selectors apply to login launch, model discovery and runtime execution after competing authentication variables are stripped. Claude Console sign-ins without API keys are not directory-isolated.

Select the independent login connection when starting a compatible session. Existing connection revisions and session-switch confirmation rules still apply. Never sign a different account into a directory already used by existing conversations. Directory isolation does not prevent external CLI tools or the user from changing the account inside that directory.

## Boundaries

The official CLI is responsible for opening the browser. Nautilo does not implement its own OAuth protocol or collect authorization codes. This flow requires an installed, compatible native CLI. Windows `.cmd`, `.bat` and `.ps1` shims are not executed by the login launcher. If the browser cannot open or the CLI requires terminal input, the UI reports the limitation rather than inventing a successful login. Other harnesses do not yet expose an isolated-account login entry point.

Cancellation retains the directory lock until the native process actually exits; browser authorization that has already completed is not revoked by closing the dialog. Cancelled/failed profile directories are not automatically deleted because they may contain CLI-managed credentials. Each new profile has a private pending-record manifest containing only its ID, provider, directory and creation time. Reopen Add account to continue a cancelled flow or retry a failed save using the same profile. A still-running process is reused, never duplicated. Saving a connection removes only this manifest; credentials remain untouched. Recovery scans at most 128 account directories and may be incomplete for larger collections. Normal sessions and delegated search strip competing API credentials before applying the selected profile.

Official references:
- https://developers.openai.com/codex/auth/
- https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts
- https://code.claude.com/docs/en/env-vars
- https://platform.claude.com/docs/en/manage-claude/wif-reference#configuration-directory

Validation covers managed-directory permissions and uniqueness, native start/cancel locking, automatic account creation only after successful exit, duplicate clicks, missing CLI, failed login and navigation cancellation. Browser authorization with actual accounts, Tauri compilation and native Windows behavior remain unverified in this environment.
