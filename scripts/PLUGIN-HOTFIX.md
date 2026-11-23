# Pi / Trae plugin-only hotfix

This path builds only `agenthub-plugin-pi` and `agenthub-plugin-trae`. It does not
build the desktop, modify application versions, create a Release, publish assets,
or write the marketplace. The existing release workflows are unchanged.

Defaults: plugin version **0.2.17**, minimum application **0.2.16**, future assets
under `zhufish-aa/nautilo-provider-registry`, tag **plugins-v0.2.17**. Keeping plugin
assets in that separate repository leaves Nautilo's desktop Latest Release alone.

## CI build

After publication of the source branch is authorized, push a branch named
`release/plugins-pi-trae-<suffix>`. The new `plugin-hotfix.yml` push trigger works
without first adding its definition to the default branch. It also supports
manual dispatch after the workflow becomes available there.

Four native jobs cover Windows x64, macOS Intel, macOS ARM64 and Linux x64. Each:

1. Runs the packaging regression tests using Node 22 with no npm installation.
2. Installs Rust stable and the explicit platform target. Windows adds MinGW.
3. Prepares the existing pinned workspace path patches for Cargo resolution.
   This is needed even with `cargo -p`; it does not compile the desktop/core.
4. Runs `cargo test --locked --target <target> -p agenthub-plugin-pi
   -p agenthub-plugin-trae -- --test-threads=1`, then release-builds those packages.
5. Runs an API v1 handshake against both release executables, without starting
   an upstream CLI, signing into an account, or making model requests.
6. Packages two `.tgz` files and their SHA-256 index, creates GitHub OIDC build
   provenance attestations, and uploads a workflow artifact.

The assembly job verifies original attestations and all eight package digests,
archive members, manifests, platform metadata and source commits. It reads the
current registry through a read-only checkout, and prepares the artifact
`plugin-hotfix-0.2.17-verified`. It includes eight packages, `SHA256SUMS.txt`,
`plugin-hotfix-manifest.json`, `registry.candidate.json` and attestation bundles.
Other registry entries and top-level fields are preserved.

Attestations are signed build provenance, not Windows Authenticode or Apple
Developer ID/notarization. No OS signing credentials are assumed. Attestation
failure stops the job; there is no silent unsigned fallback. The current app
checks package SHA-256, not these attestations. A reviewer can verify a download:

```sh
gh attestation verify nautilo-plugin-pi-0.2.17-linux-x64.tgz \
  --repo zhufish-aa/Nautilo \
  --signer-workflow zhufish-aa/Nautilo/.github/workflows/plugin-hotfix.yml
```

Attestation identity is the source/build repository, even when authorized asset
hosting later uses the separate registry repository.

## Local commands

```sh
node --test scripts/test/plugin-hotfix.test.mjs

# Run on each target OS/architecture. Requires cargo, rustup, tar and a linker.
node scripts/plugin-hotfix.mjs build \
  --version 0.2.17 --min-app-version 0.2.16 \
  --release-repository zhufish-aa/nautilo-provider-registry \
  --release-tag plugins-v0.2.17 --output build/plugin-hotfix-packages

# After downloading all four CI artifacts into one directory:
node scripts/plugin-hotfix.mjs assemble \
  --source-commit <full-source-commit> \
  --input build/plugin-hotfix-input \
  --registry /path/to/current-registry.json \
  --output build/plugin-hotfix-verified
```

All commands accept the same explicit version, minimum app version, release
repository and release tag options. Use matching values across platforms and
assembly. The optional `package --binary-directory <release-directory>` command
packages already-tested binaries; it does not itself test or build them. CI
always uses `build`, which has no test-skip switch. A missing Cargo executable
fails before source downloads. The Node tests use fake binary-header fixtures;
they verify packaging, not native plugin behavior.

Existing output is not overwritten. Use a fresh output directory after a failed
or previous package run. `assemble` requires a different, new/empty output path.
The staged manifest receives the requested plugin version and minimum app
version; source manifests and desktop `package.json` are left unchanged.

## Marketplace semantics and authorized publication

The app reads
`https://cdn.jsdelivr.net/gh/zhufish-aa/nautilo-provider-registry@main/registry.json`
(overridable with `AGENTHUB_PLUGIN_REGISTRY`). `platforms` selects the native
archive; top-level archive/checksum remain the Windows compatibility fields.

The update badge compares the numeric segments of `entry.version` against the
installed `agenthub-plugin.json` version. Use **0.2.17**, not a suffix such as
`0.2.16-hotfix.1`. Cargo crate versions are not marketplace update versions.
`minAppVersion` is an informational field at this checkout: the host does not
enforce it. Keep actual compatibility with 0.2.16 and state this requirement in
release notes; the field cannot prevent an older app from installing the package.

Only after separate publication authorization:

1. Confirm all four jobs and assembly succeeded for the intended source commit.
   Verify the final checksums and provenance; review the plugin change tests.
2. Publish the eight verified `.tgz` files, checksums and provenance to the
   designated **plugin-only** Release in the registry repository. Never trigger
   the existing `v*`, `build-v*` or `publish-v*` desktop tag workflows.
3. Check every published asset URL and digest before updating the marketplace.
4. Re-read the current registry. Its bytes must still match `baseRegistrySha256`
   in `plugin-hotfix-manifest.json`; otherwise rerun assembly using that fresh
   registry, preserving intervening unrelated changes.
5. Review and apply only the Pi/Trae entry changes from `registry.candidate.json`
   in the registry repository. The candidate file is not automatically applied.
6. Verify the origin and CDN registry, accounting for CDN caching, then confirm
   that the app's marketplace Refresh offers Pi/Trae 0.2.17 on all four platforms.

There is no rollback deletion in this pipeline. Preserve older archives and
desktop assets. A future rollback should use a new higher plugin version rather
than relying on the current marketplace to advertise a downgrade.
