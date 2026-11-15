# Patched transport dependencies

Keep only Nautilo's changes here, rather than complete third-party source trees.
`sources.json` pins each official crate's version, archive SHA-256 and the SHA-256
of its complete patched tree. The adjacent patches preserve the existing direct
transport policy, address-discovery fix and read-only NAT diagnostics.

Desktop development, release packaging (including CI) and Android builds call
`scripts/prepare-rust-sources.mjs` automatically. Node.js 22.5+, Git and `tar`
must be available. Before invoking Cargo directly, run from the repository root:

```sh
node scripts/prepare-rust-sources.mjs
# Or: pnpm rust:prepare
```

Sources, original licenses and verified archive caches are generated under
`rust/vendor/generated/`, which is ignored by Git. Once cached, preparation
requires no network; `--offline` also permits rebuilding from cached archives.
Archive, patch or generated-source verification failures stop the build.
Locally modified generated trees are preserved and reported instead of overwritten.

When updating dependencies, regenerate the patch against the exact official
crate, update both checksums and keep desktop and Android versions aligned.
See [the patch notes](../vendor/NAUTILO-PATCHES.txt) for behavior and validation scope.
