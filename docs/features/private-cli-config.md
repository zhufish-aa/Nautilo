# Private Claude launch configuration

Generated Claude `--settings` and `--mcp-config` JSON is written into unique per-run files immediately before spawn. Process arguments contain paths, not API keys, MCP authorization headers, server environment variables or runtime-bridge tokens. Claude receives the same settings precedence and MCP integration.

A dedicated per-user temporary root contains only these run directories. Unix roots and run directories require owner-only access (0700); files use 0600 and exclusive creation. On Windows, before any secret is written, built-in account/ACL tools determine the current SID, reject a reparse-point or foreign-owned root, and install a protected DACL granting only that account full control. Failure prevents launch. Windows ACL behavior and Rust compilation still require native validation.

Normal cleanup covers completion, cancellation, errors, failed startup and interrupted event consumption. Each directory records daemon and child PIDs. On subsequent config creation, bounded stale cleanup considers at most 128 entries and only reclaims marked directories older than 24 hours when both recorded processes are definitely dead. Only recognized regular files are removed, never links or unknown user files. Unknown child PIDs, alive/reused PIDs, young files, ambiguous permissions and unrecognized content are retained. Rust currently declines stale cleanup on Windows because it lacks verified process-liveness inspection there.

A forced crash before child PID registration may leave private files that cannot be safely auto-reclaimed. Stale cleanup runs on later launches, not as a guarantee of immediate removal; secure erasure is not claimed. Older temporary directories created before this format are not swept. Explicit user-entered custom CLI arguments are passed through and must not contain secrets.

Tests cover launch arguments, Unix permissions, parallel directories, cleanup, stale-directory exclusion rules and account-login cancellation locks. No real account credentials are used in tests.
