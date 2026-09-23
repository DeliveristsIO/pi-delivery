# Configuration

Delivery reads `delivery.json` from `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Existing version-1 files work unchanged:

```json
{
  "version": 1,
  "routes": {
    "planning": "provider/planning-model",
    "coder": "provider/coding-model",
    "spec": "provider/legacy-review-model",
    "quality": "provider/review-model",
    "security": "provider/security-model"
  },
  "repos": []
}
```

Use real exact IDs from the installed catalog, not these placeholders. Availability is not proof of successful inference. Every native launch specifies its exact model; no silent substitution or fallback. Combined specification/quality review uses `quality`. `spec`, `repos`, old profiles, fallback lists and old timeout/correction settings are retained in the file for compatibility but do not operate runtime machinery. Enabling delivery is an explicit session action, never automatic from `repos`.

`delivery_configure` without arguments shows routes and catalog metadata. Changes require native confirmation of exact provider/model IDs and are allowed only outside a pending plan or unresolved run. `/delivery setup` is the interactive alternative. Both preserve unrelated configuration fields. Providers receive approved task context and bounded source/diff/check evidence; review data boundaries before approving.

## Plan contract

```json
{
  "mode": "implementation",
  "title": "Fix parser error handling",
  "tasks": [{
    "title": "Reject invalid input",
    "instructions": "Implement the approved error behavior and regression tests.",
    "files": ["src/parser.js", "tests/parser.test.js"],
    "acceptance": ["Invalid input returns the specified error"],
    "checks": ["node --test tests/parser.test.js"],
    "sensitive": false
  }],
  "checks": ["npm test"],
  "security": false
}
```

Task `files` are starting points/context, not a writer permission list. Use literal relative files/directories, no globs, traversal, Git metadata or external symlinks. The coder may follow related code and update directly necessary repository files/tests without per-file approval, diagnosing and fixing task-related check failures. It must report choices and preserve unrelated preexisting dirty content. New product requirements, ambiguous outcomes, destructive actions, dependencies, provider changes and unrelated work remain unauthorized; reviewers judge product intent, not file-list membership.

Each implementation task needs executable checks; top-level checks run only after all tasks. Sensitive paths (including authentication, payments, dependencies and deployment) force security review, as does `security: true`. Detection covers both initial hints and actual changed paths, accumulated across every correction round. All implementation proposals bind the exact configured security route up front for conditional use, even with nonsensitive hints. A missing/unavailable route blocks the proposal without choosing or configuring a model; use the existing explicit route setup. All tasks receive a fresh independent combined review. In `mode: review`, every checks array must be empty: reviewers inspect existing evidence and never run commands or fix findings.

Limits are fixed and displayed: 12 tasks; 10 commands per check list; 30-minute coder / 10-minute reviewer attempts; 2-minute host-command deadline; at most two correction rounds per task. No automatic infrastructure retries, budget extensions or model escalation. Task-related check failures reuse the original approval and bounded corrections. Final-check failure reports a blocker rather than automatically replaying completed tasks: plan-wide checks have no reliable task attribution. Include task-specific regressions in task checks for automatic correction; no recovery engine guesses ownership.

## Approval and state

A plan never launches itself. Reply `Approved` / `Implement the displayed plan` or use `/delivery approve` for the displayed unchanged proposal. Conversational approval is session-local and not retained across reload. Questions, planning-only input and model-supplied intent attestations cannot approve. Changes to proposal, configured routes or tracked/untracked source snapshot before execution require a new proposal. Corrections reuse approval only within unchanged scope and limits.

Dirty and staged work may already exist; delivery never stages or commits. Snapshots include tracked/untracked nonignored files, symlink identities, index entries and HEAD. They detect review/check races and coder index/HEAD or symlink changes without undoing edits; additional ordinary repository paths do not block coding or resuming its known worker. Actual changed paths per task are retained across corrections in reviewer briefings and status details/text. Reviewers also receive a bounded preexisting diff/status preview to distinguish unrelated dirty work; it is not a full backup and does not archive untracked contents. Product relevance and preservation are enforced through worker instructions and independent review, not inferred from filenames. Ignored files and external symlink targets are not covered; this is not an OS sandbox. Large repositories, symlink ancestors and nested repositories stop with a diagnostic instead of claiming coverage.

Minimal coordinator state is appended to the Pi session branch. One exclusive lock per canonical workspace is kept under the agent directory's `delivery-locks/`, containing the owning session, run and Pi process ID. Unknown/live ownership is never automatically cleared. Do not remove a lock merely to retry; inspect the owning session/native workers and establish closure first. The same-process reload can monitor its retained worker. A different Pi process cannot reclaim the lock, even for the same session; a full-restart orphan requires manual native-worker inspection, not automatic lock stealing. Independent tools or humans that do not use delivery are outside this coordination lock.

Journal/lock ownership uses the parent Pi session UUID. Each worker separately binds pi-subagents' exact owner identity before spawn: the parent session-file path when present, otherwise the UUID for a nonpersisted session. A retained v2 worker from the earlier UUID-only binding can be normalized on stop/resume only for a known ID/directory when its parent UUID and repository still match the current parent context. The native owner is taken from that context, never from returned worker status; run ID and owner must still match exactly. A different or unverifiable binding remains blocked. Normalization preserves the worker and does not replay finished coding or checks.

`/delivery stop` requests native cancellation. `/delivery resume` only monitors an already known native worker and consumes its terminal evidence; it does not call native revival or replay coding/checks. Reload does not launch anything. Unknown launch IDs, missing terminal proof, interrupted host checks and malformed native results stay blocked with retained evidence. Inspect `delivery_status` and native subagent status, not terminal activity guesses. Unsupported `delivery-mode-v1` journals are preserved with a clear message, never resumed or migrated. Settle/inspect their workers, preserve partial work, fully restart Pi and start a fresh session. Old running sessions are not hot-migrated; the old engine's per-file approval modal is not generated by this engine.
