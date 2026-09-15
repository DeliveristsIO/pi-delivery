# Release checklist

Publication is a separate, explicit action; installation and tests do not publish anything. `package.json` currently sets `private: true` to prevent accidental npm publication. Public Git hosting is separate. Change that flag only after confirming the intended registry package name/scope and authorizing a registry release; development tests are available in the source checkout, not the runtime package artifact.

1. Resolve all correctness/security findings. Verify supported behavior separately from roadmap items.
2. Choose a license with the owner and add the corresponding LICENSE text. Do not assume permission to relicense third-party material.
3. Run `npm test`, `bash -n install.sh` and `npm run check:release`.
4. Inspect `git status`, the staged diff and `npm pack --dry-run --ignore-scripts --offline --json`. No local sessions, transcripts, private project names, credentials or identifying machine paths should appear.
5. Test installation and tests from a clean source export, without `.spark/` or user configuration.
6. Verify one fresh Pi process discovers the extension. Provider/application smoke tests require separate explicit consent; unit tests do not prove a live delivery succeeded.
7. Select the intended code host/repository, confirm ownership and visibility, then explicitly authorize commits and publication. Check the package name before any registry release.

The package uses an explicit file allowlist. `.spark/` is private ignored working storage, not release material. Never force-add it. A pattern scan is useful but cannot guarantee absence of every possible secret; inspect the final payload and Git history too.

Git/issue automation and efficiency redesign remain roadmap items. Do not advertise them as shipped configuration options.
