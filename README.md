# pi-delivery

A Pi extension for approved, model-routed development and independent review.

You describe the task, the planner proposes a plan, and you approve it in conversation. Each coding task is then handled by a coder subagent and checked by independent reviewers. Reviewers never edit code.

**Status:** pre-release. See [limitations](#limitations).

Licensed under [MIT](LICENSE).

## Requirements

- Pi coding agent (tested with 0.85.1)
- pi-subagents 0.67.0 (its RPC contract is version-sensitive)
- SPARK skills, installed as a Pi package
- frontend-design and Ollama Cloud skills/providers, installed as Pi packages
- Bash and GNU coreutils. Linux is tested; on macOS, install GNU `gln` first.
- Node.js 24+ for tests

Log in to your model providers through Pi. No credentials are bundled.

## Install

```bash
bash setup.sh             # install pinned Pi packages, link resources, then check loading
```

`setup.sh` needs `pi`, Node.js, Bash and GNU coreutils. It installs the pinned packages first (network) and links afterwards, so a link conflict never blocks installation; a conflict names the path to remove or move by hand before rerunning. Nothing is ever replaced. Add `--check` to see planned actions only, or `--skip-verify` to skip the disposable Pi loading check (that check lives in `tests/check-installed.mjs`, so an installed package skips it instead of failing).

To run each step yourself instead:

```bash
# Once, if not already installed in Pi:
npm_config_ignore_scripts=true pi install npm:pi-subagents@0.67.0
npm_config_ignore_scripts=true pi install npm:@adityaaria/spark
npm_config_ignore_scripts=true pi install npm:@sentiolabs/pi-frontend-design
npm_config_ignore_scripts=true pi install npm:pi-ollama-cloud
npm_config_ignore_scripts=true pi install npm:pi-browser-control

bash install.sh --check   # verify no conflicts
bash install.sh           # create links
```

The installer is offline and link-only. It links 3 agent profiles, 3 skills and 1 extension into `~/.pi/agent` (set `PI_CODING_AGENT_DIR` to use another directory). Nothing is ever replaced — if a path is already taken, the installer stops and tells you. Keep this checkout: the installed links point into it.

Fully exit Pi and start `pi --continue` afterwards; `/reload` can keep cached modules.

## Configure

In a Git repository you trust, run:

```text
/delivery setup
```

Pick an exact model for planning, coding, spec review, quality review and security review. Missing picks block execution. Optional ordered failover models can be supplied through `delivery_configure`; they are used only after recognized transport failures. Settings are stored in the agent directory's `delivery.json`, not in your repository.

Setup is not a recovery step. After initial configuration, ask for a specific model change in conversation: the assistant uses `delivery_configure` to inspect available models and confirm only the requested route changes. Existing plans, partial work and evidence are preserved. A pending proposal is shown again with the new routes and waits for fresh execution approval. Running or unresolved workers must settle before routes change.

Use `/delivery provider` to switch between the configured `main` and `fallback` provider groups without selecting individual models or changing repository activation. Fallbacks are used for recognized rate-limit, quota-exhaustion and transport failures after the primary route's bounded retries.

Switch the default execution profile for new plans in the current repository with `/delivery dev` or `/delivery full`. Profiles are stored per project; these commands do not alter an active or retained run in any project.

## Use

Describe the task normally, or start with `/delivery Add …`. You approve the scope, workspace and checks before anything runs.

Each new implementation task binds `reviewPolicy: balanced` by default (use `strict` for separate gates). After planning, Delivery recommends `FAST / DEV` for small low-risk scope and `FULL` for high-risk, sensitive, multi-task or broad scope, with a suggestion to split an oversized task. The recommendation is shown before execution; use `executionProfile: dev|default` in the proposal to choose explicitly. Fast runs shorter bounded budgets, one correction round and no optimizer pass; full runs the complete lifecycle. Balanced runs one coder, focused checks, then one combined spec+quality review; security runs only for explicitly sensitive tasks. Strict runs the optimizer and separate spec, quality and security reviews. Approved tasks are committed before the next task; bounded corrections restart review without a second optimizer.

Release checks run once, after **all** tasks.

For frontend tasks, mark the affected task with `browser: true`. Delivery then requires an active `pi-browser-control` extension and grants the coder/reviewer browser tools for that task. Browser interaction is bounded verification evidence: agents may open the local app, inspect screenshots/DOM/layout, click/type, read console errors and reload, but browser state never expands source scope or authorizes a commit. Review the third-party package before installing it. [pi-browser-control package details](https://pi.dev/packages/pi-browser-control).

To execute an existing Markdown plan, say:

```text
Execute the plan docs/feature-plan.md
```

For review-only (no edits), ask something like: "review the last two commits."

## Status and recovery

```text
/delivery status
/delivery models
/delivery resume
/delivery off
```

If a run gets stuck, check `/delivery status` first. Reviewers are never given write tools; security rejections cannot edit code. Do not loop on approval or reset session files.

Status identifies the next action, the models bound to the retained plan, models configured for future plans, native worker evidence and recorded host checks. A closed failed attempt needs a corrective proposal from retained requirements; it does not require a new session or another setup. Calling resume on a running, completed or already-closed run returns guidance without launching a duplicate worker.

When a stopped review has findings on an existing dirty candidate, an explicitly requested implementation plan can use `correctionAdoption: { kind: "retained-candidate", userTurn: "<exact current request>" }` together with matching `executionIntent`. The controller binds the current session, repository, branch, HEAD, exact changed-file inventory, index inventory and candidate fingerprint. This supported path needs no WIP commit, stash or baseline commit. Standalone review remains read-only and does not authorize writes; a finding or arbitrary “continue” message is not consent. Live or unresolved workers, changed ownership/content, foreign staging, out-of-scope paths and unsafe symlinks fail closed. The full adopted candidate, including original changes rather than only the correction delta, reruns checks and independent reviews before an extension-owned commit.

During an active owned delivery run, only the exact journaled child/request may receive an automatically admitted supervisor envelope (`kind: evidence|clarification`, bounded `content`, `nonAuthoritative: true`). Its content is untrusted evidence only: it cannot authorize scope, files, model, budget, deadline, tools, checks, reviews, commits, branches, pushes, merges or deployment. Malformed or unsafe replies are blocked.

An exact model-exclusion rejection before launch can be reconciled with `delivery_resume`, including after reload. Unknown launch errors remain blocked until investigated. To prioritize checks in a running coder, the assistant can use `delivery_steer`; its fixed message preserves scope, model and deadline. The acknowledgment confirms runner acceptance only, not worker delivery or completed checks.

Defaults: 45 minutes per coder attempt (plus one 15-minute continuation, capped at 60 cumulative minutes per task), 15 minutes per reviewer, 2 minutes per command (configurable), and 4 correction rounds per new task. If a coder exhausts its allowance, `/delivery resume` can approve one additional bounded recovery attempt on the same task and scope; it never creates a commit, checkout or replacement task automatically. Every implementation task requires its own `tasks[].checks`; top-level checks are release gates that run once, after all tasks. See [docs/configuration.md](docs/configuration.md).

The optional execution profile can be selected through `delivery_configure` or per proposal:

```json
{ "profile": "dev" }
```

Use `default` for the full delivery flow. The profile applies only to newly proposed implementation runs in the current project; retained runs keep their bound policy.

Fast/dev and full use adaptive scope by default. If implementation legitimately needs an undeclared file, delivery pauses before checks or commit and exposes the exact discovered files. `delivery_scope` can approve those files after confirmation, or preserve them for a split/new plan. It never deletes or checks out changes automatically. Use `scopePolicy: "strict"` explicitly when undeclared files must always block.

The temporary version-1 correction setting is:

```json
{
  "corrections": { "maxFixRounds": 4 }
}
```

`maxFixRounds` accepts integers `0..8`; the default is 4 for new plans. Older retained plans remain at 2 until explicit migration. Phase 2 will move this setting into profiles while preserving this migration behavior.

## Limitations

- Trusted-session safeguards, **not an OS sandbox**. Workers run with your account permissions.
- Do not run competing writers in the same workspace.
- Ordinary new implementation deliveries require a clean worktree, bind a feature/bug/chore branch, and create review-gated logical task commits only after fresh spec, quality and security approvals. Explicit `correctionAdoption` is the narrow exception for a proven reviewed dirty candidate. Review and retained legacy plans remain compatible and do not create branches or commits. Pushes, merges and deployments remain manual.
- Reload or restart Pi after updating the extension. Pending correction adoption survives reload only in the owning session and repository with unchanged branch, HEAD, inventory, index and fingerprint; otherwise prepare a fresh review/proposal. Passing host checks are check evidence, never review approval.
- Native pi-subagents workers only; no external coding-CLI fallback.
- Installation is not transactional. On conflicts, resolve and rerun.

## Develop

```bash
npm test                          # no dependencies needed
bash -n install.sh
node tests/check-installed.mjs /path/to/trusted/repository
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [tests/README.md](tests/README.md) and [SECURITY.md](SECURITY.md).
