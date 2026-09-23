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

Use literal relative files/directories, no globs, traversal, Git metadata or external symlinks in scope. Each implementation task needs executable checks; top-level checks run only after all tasks. Sensitive paths (including authentication, payments, dependencies and deployment) force security review, as does `security: true`. All tasks receive a fresh independent combined review. In `mode: review`, every checks array must be empty: reviewers inspect existing evidence and never run commands or fix findings.

Limits are fixed and displayed: 12 tasks; 10 commands per check list; 30-minute coder / 10-minute reviewer attempts; 2-minute host-command deadline; at most two correction rounds per task. No automatic infrastructure retries, budget extensions or model escalation. Final-check failure reports a blocker rather than automatically replaying completed tasks.

## Approval and state

A plan never launches itself. Reply `Approved` / `Implement the displayed plan` or use `/delivery approve` for the displayed unchanged proposal. Conversational approval is session-local and not retained across reload. Questions, planning-only input and model-supplied intent attestations cannot approve. Changes to proposal, configured routes or tracked/untracked source snapshot before execution require a new proposal. Corrections reuse approval only within unchanged scope and limits.

Dirty and staged work may already exist; delivery never stages or commits. Snapshots include tracked/untracked nonignored files, symlink identities, index entries and HEAD. They detect review/check races and out-of-scope writer changes without undoing edits. Ignored files and external symlink targets are not covered; this is not an OS sandbox. Large repositories, symlink ancestors and nested repositories stop with a diagnostic instead of claiming coverage.

Minimal coordinator state is appended to the Pi session branch. One exclusive lock per canonical workspace is kept under the agent directory's `delivery-locks/`, containing the owning session, run and Pi process ID. Unknown/live ownership is never automatically cleared. Do not remove a lock merely to retry; inspect the owning session/native workers and establish closure first. The same-process reload can monitor its retained worker. A different Pi process cannot reclaim the lock, even for the same session; a full-restart orphan requires manual native-worker inspection, not automatic lock stealing. Independent tools or humans that do not use delivery are outside this coordination lock.

`/delivery stop` requests native cancellation. `/delivery resume` only monitors an already known native worker and consumes its terminal evidence; it does not call native revival or replay coding/checks. Reload does not launch anything. Unknown launch IDs, missing terminal proof, interrupted host checks and malformed native results stay blocked with retained evidence. Inspect `delivery_status` and native subagent status, not terminal activity guesses. Unsupported `delivery-mode-v1` journals are preserved with a clear message, never resumed or migrated. Settle their workers before starting a new session.
