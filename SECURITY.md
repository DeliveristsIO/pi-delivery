# Security boundaries

Delivery is a trusted-session coordinator, **not an OS sandbox**. Pi extensions share process/account permissions. Load only trusted extensions, agents, providers and repositories. Report security issues privately to the repository maintainer; do not include credentials, transcripts or private project paths in public issues.

## Controls

- No writer launches before explicit user approval of a displayed unchanged plan. Exact configured model routes and workspace snapshot are bound to that proposal.
- One native writer at a time; an exclusive per-workspace delivery lock prevents a second delivery session from writing concurrently. Unknown launches and unproven closure are never replayed. Other tools/processes outside delivery do not honor this lock.
- Reviewers are fresh native sessions with strict `read`, `grep`, `find`, `ls` allowlists and explicit shell/write exclusions. Review mode executes no host checks and no fixes. Agent/settings overrides and installed runtime code remain trusted configuration; do not broaden those profiles.
- Parent tool hooks block unmanaged shell, writes, delegation and external tools while delivery is enabled. Coordinator Git helpers use fixed read-only arguments, disable external diff/text conversion and refuse configured clean/process filters.
- Native completion requires matching run/session/agent/model evidence, terminal process proof and a valid structured report. Check receipts contain actual host exit codes/output. No activity or model claim is treated as verification.
- Dirty work is preserved without cleanup, Git writes, stash or baseline commits. Out-of-scope changes stop for inspection, never automatic rollback. Snapshots cover tracked/untracked nonignored regular files and symlink identities; ignored files and external targets are not covered.

## Remaining trust

Approved commands and coder shell tools run with your account permissions. They can execute project scripts and access files/network; prompts prohibit Git writes and unrelated edits but cannot sandbox arbitrary shell. Approve only commands and repositories you trust. Built-in read tools may read beyond the workspace; avoid secrets in task context. Runtime artifacts, session records and provider requests may contain source and check output. Do not publish them.

Infrastructure failures stop. Stop acknowledgement is not process closure. Never remove unknown/live locks, alter journals to fabricate approval or switch models to bypass a failure. Unsupported old journals remain preserved and require manual native-worker inspection before a fresh session.

Release scans detect common secret patterns but are not exhaustive. See [release guidance](docs/releasing.md).
