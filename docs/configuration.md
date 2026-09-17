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

## Model connection recovery

Delivery treats native `partial` runs as failed attempts, including cases where the runner itself exits successfully. Once process closure and exact model identity are confirmed, recognized connection errors retry automatically on the same approved route after 5 and 10 seconds, at most twice per task, review round and stage. If those retries are exhausted, an optional ordered fallback route for that role is tried, one route at a time, within the same remaining budget. No additional approval is needed. Authentication errors, unknown failures and uncertain launches are not automatically retried.

Retries preserve partial files and prior session logs, rerun the required review/check sequence, and consume the existing time allowance. Review retries share the original review budget; coder retries share the task coding budget. Retry counts and pending retries survive session reloads. After restarting Pi, enter `/delivery`. It detects retained work and offers a confirmation to resume; `/delivery resume` remains available as a direct command. Declining preserves the run. If a worker is already running, `/delivery` shows its status without starting another worker.

Recovery is stage-aware. A failed review can attach only to its exact current task, round, blocker and candidate, and that authority is consumed by the result. A pre-staging commit failure may retry preparation from unchanged accepted evidence; an authorized staged-commit failure may retry only the identical staged snapshot. Missing or changed evidence returns through checks and mandatory reviews, while foreign staging or unprovable ownership stays blocked. Genuine correction/time exhaustion requires an explicit decision and is never bypassed by raising limits or looping automatic retries. No unconfigured model substitution, fabricated approval, arbitrary correction-limit increase or silent foreign unstage occurs. Fallbacks must be exact available provider/model IDs bound before approval.

### Reviewed dirty-candidate correction

A stopped failed review or failed implementation can expose an explicit correction path without a checkpoint loop. The new implementation proposal supplies `correctionAdoption: { kind: "retained-candidate", userTurn: "<exact current request>" }` and a matching `executionIntent`. Its single corrective task must keep the exact retained review scope. The controller binds the owning session and repository, current branch and HEAD, exact tracked/untracked changed inventory, index inventory and candidate fingerprint. It preserves retained reports, original review requirements, unfinished tasks, applicable final checks, coding spend and correction/time limits. No WIP commit, automatic stash or baseline commit is created.

Standalone review is still read-only and does not authorize correction. Attached review findings also stop before a coder starts; findings and generic “continue” text are not implementation consent. Adoption fails closed for live or unresolved workers, stale branch/HEAD/fingerprint, changed or foreign staging, out-of-scope edits, traversal/pathspec widening, symlink ancestry or unprovable lineage. In-scope staging is bound exactly and normalized only after adoption validation so later staging remains extension-owned without losing file content. Checks and independent reviews cover the full adopted candidate, including original changes, before a logical commit. A green host check is check evidence, not review approval.

An already running Pi process must reload the extension (or restart with `pi --continue`) to use an updated checkout. A pending adoption can survive reload only in the same owning session and repository while its branch, HEAD, inventory, index and fingerprint remain unchanged; changed evidence requires a fresh review/proposal.

## Planning questions

The planning agent can ask focused questions in conversation before submitting a plan when requirements are unclear. It first checks repository context and prior decisions, then waits for answers to material questions. Answers inform the proposal; execution approval is requested after the resolved plan is shown. No special question command is needed.

## Missing worker records after a reboot

On Linux, delivery compares the retained worker start time with the current host boot time when its native `status.json` is missing. If a reboot proves the old worker cannot still be running, startup, `/delivery setup`, and `delivery_resume` retire that attempt without launching another worker. The plan, partial files, reviews and retry history remain intact. The reserved coding allowance is charged in full because the actual runtime cannot be verified. Setup can then change routes; further execution requires a corrective plan and its approval.

Missing files by themselves do not establish closure. Same-boot cleanup, unknown start times, unsupported boot evidence and existing malformed status files remain unresolved; delivery does not release a potentially live writer. No successful result or passed check is inferred from a reboot.
