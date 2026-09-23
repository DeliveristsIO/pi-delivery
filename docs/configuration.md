# Configuration

Run `/delivery setup` rather than copying another person's configuration. Choose five exact `provider/model` routes: `planning`, `coder`, `spec`, `quality`, `security`. Providers and credentials are configured through Pi separately.

The installer never writes configuration or authentication. Delivery configuration lives in `$PI_CODING_AGENT_DIR/delivery.json`, defaulting to `~/.pi/agent/delivery.json`. Repository opt-ins are local canonical paths and should not be committed.

Optional timeout values, in milliseconds:

```json
{
  "timeouts": {
    "coderMs": 2700000,
    "continuationMs": 900000,
    "reviewMs": 900000,
    "commandMs": 120000,
    "idleWarningMs": 300000,
    "deadlineWarningMs": 300000
  }
}
```

For small, low-risk changes, select the development profile:

```json
{ "profile": "dev" }
```

In Pi, the same setting can be changed for the current repository with `/delivery dev` or `/delivery full`. Profiles are stored per project. The commands affect new plans only; an active or retained run keeps its bound profile.

`dev` uses a 10-minute coder budget, a 5-minute continuation/reviewer budget, 1-minute commands, one correction round and no optimizer pass. The planner still shows a recommendation before execution; use `executionProfile: "default"` on a proposal when the full flow is appropriate. High-risk, sensitive, multi-task or broad plans are recommended for the full profile. Profiles are bound to new plans, so changing configuration does not alter retained work.

The development and full profiles use `scopePolicy: "adaptive"` by default. If the coder or a review-driven correction discovers a necessary file outside the current task, delivery pauses before checks/reviews or commit and exposes the exact files through `delivery_scope`. `approve` adds only those files to the task and reruns checks and reviews; `reject` or `split` preserve the files and leave the run blocked. No automatic checkout or deletion is performed. Choose `scopePolicy: "strict"` explicitly when undeclared files must always block.

This is a timeout fragment, not a complete configuration. Each value must be a whole millisecond count between one minute and two hours; `continuationMs: 0` disables continuation. `commandMs` bounds each host verification command (default two minutes); a command that exceeds it terminates and fails its check. Coder attempts and review fixes share the cumulative per-task allowance. Route/budget changes require reapproval where they affect retained execution bindings.

Task commands belong in `tasks[].checks`; whole-change release gates belong in top-level `checks`. Multi-task implementation plans require per-task checks. Commands run with the user's permissions; executable/syntax validation is not a shell sandbox.

The temporary version-1 correction setting is:

```json
{
  "corrections": { "maxFixRounds": 4 }
}
```

`maxFixRounds` accepts integers `0..8`. The default is `4` for new plans; older retained plans remain at `2` until explicit migration. Phase 2 will move this setting into profiles while preserving this migration behavior.

New implementation plans supply `changeType: feature|bug|chore` and bind `reviewPolicy: balanced|strict` (`balanced` is the default). Each task declares `sensitive: true|false`; balanced runs task security review only for sensitive tasks, while strict always runs it. The lifecycle is coder → focused checks → one fresh bounded optimizer → checks only if source changed → combined spec+quality (balanced) or separate spec/quality/security (strict) → exact-path logical commit. Corrections invalidate approvals and restart review without a second optimizer. Before proposal the tracked and untracked worktree must be clean. The extension selects the default branch without network access, binds a safe `<prefix>/<slug>` branch (or continues on an existing clean non-default branch), and creates it only after approval. Literal approved directories are expanded to their concrete changed-file inventory; sibling prefixes, pathspec metacharacters, traversal, symlink ancestors and foreign staging do not widen commit authority. Commits, branch identity, HEAD and snapshots are revalidated; failures remain resumable without replaying the coder. Review-only and retained legacy plans do not create branches or commits. Git and remote issue-action configuration is not user-configurable; do not add speculative keys expecting them to grant permissions.

## Bounded safe recovery

### One retained host-check timeout

Do not edit `delivery.json` to recover a single slow check. Inspect `delivery_status`, then request the exact retained check using the `delivery_resume` tool, for example:

```json
{"commandTimeout":{"stage":"verification","task":0,"index":1,"command":"bundle exec rails test","timeoutMs":900000}}
```

`task` and ordered check `index` are zero-based; copy the exact stage and command from status. The increased deadline must be a finite integer from 60000 through 1800000 ms (30 minutes maximum). One native confirmation displays the command, old/new deadline, retained stage and remaining commands. Only that check gets the override; e.g. Brakeman keeps its original deadline. Global/project configuration, coding/correction budgets, routes and review scope do not change. This does not authorize code fixes or mark a timeout as passing.

The session journal retains the ordered verification cursor, attempts and override across reload. Earlier passing checks are reused only for the identical session, repository, stage, task/round, ordered commands, snapshot, HEAD and retained review/candidate bindings. Successful final verification completes normally; outstanding aggregate reviews still run when required by the existing lifecycle. Plain resume retries outstanding checks at their existing deadlines.

Recovery requires a persisted, conclusively closed host timeout receipt. An arbitrary SIGKILL is not proof of a deadline. Legacy journals missing the scoped cursor/closure evidence explain that limitation rather than guessing; live or unknown host/worker attempts remain blocked. Inspect current-session native receipts/status, not silence. No UI means no override: reopen the same session in interactive Pi or an RPC client supporting confirmation. Changed state during confirmation invalidates it. Never repair session JSON or raise global timeouts to bypass these checks.

Safe recovery uses the existing approval, not a new mode. A known read-only preflight rejection proving non-launch retries once per task/round/stage with unchanged routes, fallbacks, scope and remaining budget. The persisted attempt marker is consumed before dispatch and survives reload; no repeated confirmation, coder replay or completed-check replay occurs. Unknown launches and exhausted retries remain blocked. Model-exclusion diagnostics do not authorize model substitution.

Parent inspection uses `delivery_inspect` with `view: status|history` and optional character `offset` (40k-character pages). It has fixed argv, no shell or arbitrary arguments, no Git aliases, pager, fsmonitor, signature execution or optional index writes. Use `delivery_diff` for patches and read/search tools for source. Status inspection refuses effective Git configurations containing clean/process filters, since status can execute these commands; history and direct source reads remain available. This is not a general shell sandbox. Unrelated unsafe symlinks warn; required unsafe dependencies still block and targets are never repaired automatically.

## Controlled preflight cleanup

`delivery_cleanup` is a narrow tool, not a shell escape or automatic cleanup setting:

1. `phase: inspect, paths: ["exact/relative/path"]` reads tracking and content, returns the exact inventory, SHA-256 snapshot, current session/repository/branch/HEAD binding, token and external recovery intent. No files are moved or created.
2. `phase: apply, token: "<returned token>"` shows one native confirmation: move the named paths to the displayed recoverable backup, and confirm no other process is writing to them. Cancel when writer ownership is unknown. Model-supplied consent and cleanup keywords cannot bypass confirmation. TUI or an RPC client implementing native confirmations is required.
3. Apply revalidates the binding and contents, fsyncs validated regular-file payloads and then candidate directories bottom-up before any relocation (failing closed on errors), creates a private sibling `.pi-delivery-recovery-<token>` directory exclusively, writes/fsyncs `manifest.json` and `events.jsonl` before moving anything, then atomically renames each exact path. It journals partial progress and rechecks status. It does not commit, stash, reset, delete or launch workers. We never delete backups or classify artifacts as disposable by basename, including `.claude-flow`, `.swarm` and `ruvector.db`.

The manifest gives exact absolute `source` and `destination` recovery paths. After interruption, compare both locations with the manifest and append journal; an interrupted `moving` record may already have moved. Restore each destination only when its original source is absent. If occupied, keep both copies and restore to another empty location. Recovery never requires deletion or overwriting. There is no automatic rollback, restore tool or partial-operation replay. Backup contents survive extension restart; in-memory inspection tokens do not. A successful token replay in the same session returns its receipt without another confirmation or move.

Cleanup never grants implementation authority. The planner may retry only the same preflight-blocked proposal under the original real-user intent; changed proposals or material bindings require fresh intent. Planning-only remains planning-only. Cleanup does not renew a previously fingerprinted Markdown-file execution request; that request must be rebound through the existing execution gate after the workspace changes. No cleanup approval is repeated merely to retry a proposal.

Limits are deliberately conservative: 1–20 non-overlapping relative paths, at most 100 inventory entries / 16 MiB; no glob, root, traversal, control-character or metadata paths. All tracked/staged dirt blocks cleanup. Candidates must be visible untracked files/directories with no ignored contents, symlinks/ancestors, hardlinks, special files or nested repositories. `.git`, Git control files, `.pi` and `.spark` stay protected. Linked/separate Git dirs, common-dir worktrees, detached/unborn HEAD, cross-device moves and configured clean/process filters are refused. No filter/hook/shell is executed by cleanup inspection. Active/unresolved or retained unfinished delivery ownership blocks cleanup; completed historical runs alone do not. Existing dirty-work adoption rules are unchanged.

This is a trusted-session safeguard, not an OS sandbox or a process detector. The user must stop competing writers, including other sessions. Native confirmation is the writer assertion; it cannot make a hostile concurrent filesystem race safe. Renames are atomic per path, not transactional across the entire inventory. The writable worktree parent must be on the same filesystem and support directory fsync. No copy-and-delete fallback is attempted. Keep recovery directories until you decide what to retain.

Durability covers process interruption and host crash/power loss only on filesystems and storage that honor successful file and directory fsyncs and atomic same-filesystem rename. Before any move, every candidate regular file is opened without following symlinks, checked against its inspected identity/content and fsynced; candidate directories are then fsynced bottom-up. Any payload sync error aborts before creating a backup or relocating any source. Manifest/journal synchronization and post-rename source-parent and backup-directory fsyncs remain required before recording completed moves. A crash before those barriers finish can leave the current move at either location; inspect both against the durable manifest. Recently written data is not guaranteed durable before the payload barriers complete. Hardware failure, lying device caches, unsupported/network filesystem semantics and competing writers are outside this guarantee. Tests verify synchronization ordering and error handling; abrupt subprocess exit tests do not simulate power loss or validate storage hardware.

## Model connection recovery

Delivery treats native `partial` runs as failed attempts, including cases where the runner itself exits successfully. Once process closure and exact model identity are confirmed, recognized connection errors retry automatically on the same approved route after 5 and 10 seconds, at most twice per task, review round and stage. If those retries are exhausted, an optional ordered fallback route for that role is tried, one route at a time, within the same remaining budget. No additional approval is needed. Authentication errors, unknown failures and uncertain launches are not automatically retried.

Retries preserve partial files and prior session logs, rerun the required review/check sequence, and consume the existing time allowance. Review retries share the original review budget; coder retries share the task coding budget. If a coder exhausts that allowance, `/delivery resume` offers one bounded same-model recovery grant for the retained task after confirmation; no new plan, commit, checkout or scope change is created. Retry counts and pending retries survive session reloads. After restarting Pi, enter `/delivery`. It detects retained work and offers a confirmation to resume; `/delivery resume` remains available as a direct command. Declining preserves the run. If a worker is already running, `/delivery` shows its status without starting another worker.

Recovery is stage-aware. A failed review can attach only to its exact current task, round, blocker and candidate, and that authority is consumed by the result. A pre-staging commit failure may retry preparation from unchanged accepted evidence; an authorized staged-commit failure may retry only the identical staged snapshot. Missing or changed evidence returns through checks and mandatory reviews, while foreign staging or unprovable ownership stays blocked. Genuine correction/time exhaustion requires one explicit bounded recovery decision and is never bypassed by raising limits or looping automatic retries. No unconfigured model substitution, fabricated approval, arbitrary correction-limit increase or silent foreign unstage occurs. Fallbacks must be exact available provider/model IDs bound before approval.

### Browser verification

Tasks that need live web/UI verification set `browser: true`. Delivery fails early if browser-control tools are not active instead of silently claiming browser checks ran. The coder and read-only reviewers receive browser tools declared by the installed `pi-browser-control` extension; browser actions remain evidence only and cannot change delivery scope, Git state or approval. Use the extension's `/browser` commands to connect or launch a local Chromium-based browser before execution.

### Reviewed dirty-candidate correction

A stopped failed review or failed implementation can expose an explicit correction path without a checkpoint loop. The new implementation proposal supplies `correctionAdoption: { kind: "retained-candidate", userTurn: "<exact current request>" }` and a matching `executionIntent`. Its single corrective task must keep the exact retained review scope. The controller binds the owning session and repository, current branch and HEAD, exact tracked/untracked changed inventory, index inventory and candidate fingerprint. It preserves retained reports, original review requirements, unfinished tasks, applicable final checks, coding spend and correction/time limits. No WIP commit, automatic stash or baseline commit is created.

Standalone review is still read-only and does not authorize correction. An explicitly attached recovery review can instead return findings to the original already-approved implementation when exact Git ownership, scope, candidate and route/budget bindings are proven. This consumes its existing correction round and remaining coding budget and preserves all review gates; it does not derive write authority from the review. Older stopped attached findings can use `delivery_resume` under the same provenance checks. Legacy implementation journals without Git ownership still require explicit adoption; findings and generic “continue” text alone are not new implementation consent. Adoption fails closed for live or unresolved workers, stale branch/HEAD/fingerprint, changed or foreign staging, out-of-scope edits, traversal/pathspec widening, symlink ancestry or unprovable lineage. In-scope staging is bound exactly and normalized only after adoption validation so later staging remains extension-owned without losing file content. Checks and independent reviews cover the full adopted candidate, including original changes, before a logical commit. A green host check is check evidence, not review approval.

An already running Pi process must reload the extension (or restart with `pi --continue`) to use an updated checkout. A pending adoption can survive reload only in the same owning session and repository while its branch, HEAD, inventory, index and fingerprint remain unchanged; changed evidence requires a fresh review/proposal.

## Planning questions

The planning agent can ask focused questions in conversation before submitting a plan when requirements are unclear. It first checks repository context and prior decisions, then waits for answers to material questions. Answers inform the proposal; execution approval is requested after the resolved plan is shown. No special question command is needed.

## Missing worker records after a reboot

On Linux, delivery compares the retained worker start time with the current host boot time when its native `status.json` is missing. If a reboot proves the old worker cannot still be running, startup, `/delivery setup`, and `delivery_resume` retire that attempt without launching another worker. The plan, partial files, reviews and retry history remain intact. The reserved coding allowance is charged in full because the actual runtime cannot be verified. Setup can then change routes; further execution requires a corrective plan and its approval.

Missing files by themselves do not establish closure. Same-boot cleanup, unknown start times, unsupported boot evidence and existing malformed status files remain unresolved; delivery does not release a potentially live writer. No successful result or passed check is inferred from a reboot.
