# pi-delivery

A thin SPARK coordinator for [Pi](https://github.com/earendil-works/pi). SPARK guides methodology; **pi-subagents owns native worker execution**. Delivery routes exact configured models, passes approved context and results, and displays progress.

## Flow

**Plan → explicit approval → implement → task checks → independent combined specification/quality review → security review when sensitive → report.** Final checks run only after all tasks pass review. Concrete task-check/review failures allow at most two correction rounds under the unchanged approval. Infrastructure failures stop; there are no automatic retries or fallback models.

Read-only review runs fresh reviewers with native `read`, `grep`, `find`, `ls` tool allowlists. It never runs shell checks or launches fixes. No OS sandbox is claimed.

There is no optimizer, dev/full profile, alternate review policy, automatic Git branch/staging/commit/merge, workspace cleanup, candidate adoption or migration engine. Existing dirty work is allowed; unrelated edits must be preserved. No baseline commit or stash is required.

## Install

Requires Node.js 24+, Pi, Bash and GNU coreutils. Install the dependencies and link resources:

```bash
bash setup.sh --check   # inspect only
bash setup.sh
```

Bootstrap installs the pinned `pi-subagents@0.67.0`, SPARK, frontend-design and Ollama Cloud packages if missing. The optional design/provider packages are not required by the delivery pipeline. For already installed dependencies, `bash install.sh` only creates no-clobber links into `PI_CODING_AGENT_DIR` or `~/.pi/agent`; `--check` makes no changes. After active workers settle, fully restart Pi. Installation does not publish anything.

## Use

In a trusted repository, use `/delivery setup` only if exact model routes are not already configured, then `/delivery on`. Discuss requirements using SPARK and ask for a delivery plan. The proposal shows task scope, checks, routes and limits. Reply **Approved** or **Implement the displayed plan**, then the coordinator calls `delivery_execute`. `/delivery approve` is the explicit command equivalent. Questions or planning-only requests never launch work. Changed proposals need fresh approval.

Tools: `delivery_plan`, `delivery_execute`, `delivery_status`, `delivery_configure`.
Commands: `/delivery on|off|status|approve|stop|resume|setup` (no argument shows status).

`stop` requests native cancellation, not proof of closure. `resume` only monitors the same known worker after reload/interruption; it never revives or replaces one. Unknown launches or check closure block new work. Unsupported old journals are preserved, not resumed or migrated: inspect/settle their native workers and retain partial files before using a new session.

Existing version-1 model configuration remains usable without setup. Combined review uses `quality`; `spec` and other legacy settings remain stored but do not control runtime behavior. See [configuration](docs/configuration.md) and [security boundaries](SECURITY.md).

## Verify

```bash
npm test
bash -n install.sh setup.sh
npm run check:release
node tests/check-installed.mjs /path/to/trusted/repository
```

The optional last command loads an ephemeral offline Pi session without inference or worker launches. If invoked from a subagent shell, set `PI_SUBAGENT_CHILD=0` for this isolated loading probe; child sessions intentionally do not register the coordinator. Tests exercise synthetic native RPC/artifact contracts, not provider end-to-end delivery.

[Contributing](CONTRIBUTING.md) · [Tests](tests/README.md) · [Roadmap](docs/roadmap.md) · [Releasing](docs/releasing.md)
