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

Pick an exact model for planning, coding, spec review, quality review and security review. Missing picks block execution — there is no silent fallback. Settings are stored in the agent directory's `delivery.json`, not in your repository.

Setup is not a recovery step. After initial configuration, ask for a specific model change in conversation: the assistant uses `delivery_configure` to inspect available models and confirm only the requested route changes. Existing plans, partial work and evidence are preserved. A pending proposal is shown again with the new routes and waits for fresh execution approval. Running or unresolved workers must settle before routes change.

## Use

Describe the task normally, or start with `/delivery Add …`. You approve the scope, workspace and checks before anything runs.

Each implementation task goes through:

1. One coder.
2. The task's checks.
3. Independent spec and quality reviews.
4. Independent read-only security review when required.
5. Bounded fixes if necessary.

Release checks run once, after **all** tasks.

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

During an active owned delivery run, supervisor replies are accepted as informational evidence or clarifications without an extra confirmation prompt, including non-UI contexts. They cannot authorize scope, model or budget changes, waive reviews, or broaden tool permissions; those remain subject to the explicit delivery approval mechanisms.

An exact model-exclusion rejection before launch can be reconciled with `delivery_resume`, including after reload. Unknown launch errors remain blocked until investigated. To prioritize checks in a running coder, the assistant can use `delivery_steer`; its fixed message preserves scope, model and deadline. The acknowledgment confirms runner acceptance only, not worker delivery or completed checks.

Defaults: 45 minutes per coder attempt (plus one 15-minute continuation, capped at 60 cumulative minutes per task), 15 minutes per reviewer, 2 minutes per command (configurable), at most 2 fix rounds per task. Every implementation task requires its own `tasks[].checks`; top-level checks are release gates that run once, after all tasks. See [docs/configuration.md](docs/configuration.md).

## Limitations

- Trusted-session safeguards, **not an OS sandbox**. Workers run with your account permissions.
- Do not run competing writers in the same workspace.
- No automatic commits, pushes, merges or deployments. Git/issue automation is [planned](docs/roadmap.md).
- Native pi-subagents workers only; no external coding-CLI fallback.
- Installation is not transactional. On conflicts, resolve and rerun.

## Develop

```bash
npm test                          # no dependencies needed
bash -n install.sh
node tests/check-installed.mjs /path/to/trusted/repository
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [tests/README.md](tests/README.md) and [SECURITY.md](SECURITY.md).
