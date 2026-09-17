---
name: orchestrate-delivery
description: Use when coordinating approved development through the installed delivery extension and its independent reviews.
---

# Delivery coordination

Use SPARK for research, debugging, design, TDD and verification. Use the installed delivery extension for approval bindings and native worker lifecycle. Do not create a second dispatch loop.

## Prepare

Read repository instructions and relevant project memory. Resolve genuine scope questions using the appropriate SPARK skills. Select the intended workspace before activating delivery. New implementation plans bind a feature/bug/chore Git lifecycle and `reviewPolicy` (balanced by default, strict opt-in): balanced tasks use coder → checks → one bounded optimizer → affected checks when changed → combined spec+quality → conditional sensitive-task security → commit; strict uses separate spec, quality and security. Proposal requires a clean worktree, approval creates only the bound branch, and reviewed task commits are orchestrated by the extension. Retained legacy and review plans remain read-only/compatible.

If delivery tools are missing, request installation and a full Pi restart after workers settle. Do not pretend workers ran. `/delivery setup` selects exact routes and obtains provider-context consent. Never silently substitute models.

Do not repeat setup as a recovery ritual. Inspect `delivery_configure` without arguments for configured routes and available exact IDs. For a user-requested route change, supply only the selected roles and exact model IDs to `delivery_configure`; it shows provider-context confirmation and preserves retained work. Unchanged routes need no confirmation. A pending plan is redisplayed with updated bindings and requires fresh conversational execution approval; do not recreate its scope merely to change models. Do not infer model speed or quality from its name.

## Clarify during planning

Ask the user in normal conversation when missing information materially affects scope, expected behavior, acceptance criteria or implementation choices. First inspect available repository context and prior answers. Do not ask again about settled decisions.

Ask one focused question at a time, with concrete options when useful. Wait for the answer before finalizing the affected plan details; independent read-only investigation can continue. Do not guess requirements or submit a plan simply to avoid asking. When requirements are already clear, proceed directly to the proposal.

A clarification answer supplies requirements, not execution approval. Incorporate it into the plan, show the resolved proposal and then obtain approval for that proposal.

## Propose and execute

- For a new proposal, call `delivery_plan` with coherent tasks, acceptance criteria, file scope, executable checks, and `changeType: feature|bug|chore` for implementation Git lifecycle deliveries. Put current-task checks in `tasks[].checks` and release gates in top-level `checks`.
- For an existing Markdown plan, use `delivery_execute` with `planFile`, read the returned source document and derive its tasks with `delivery_plan` using the same path. Preserve its boundaries and constraints.
- A new proposal needs a fresh real user approval before `delivery_execute`. Questions, rejection and approval of an earlier proposal are not permission for the current candidate. The unchanged explicitly requested source-document flow retains its own bound authorization.
- Let delivery own dispatch and progression. Do not call unmanaged subagent execution tools or grant write tools to reviewers.

## Recover safely

Use `delivery_status` for retained state and `delivery_resume` for supported recovery. Users can enter `/delivery` without arguments to get a resume confirmation for retained work; do not require them to remember a recovery subcommand. Recovery is stage-aware: exact current failed-review lineage is one-shot; unchanged accepted evidence may resume commit preparation or the identical authorized staged commit; stale evidence reruns required checks/reviews. Never fabricate approval, skip review gates, silently unstage foreign content, replay an unknown launch or reset exhausted rounds merely because the user said “continue.” Unsafe or unprovable workspace/child ownership remains blocked. If no proposal is pending, follow the exact status action rather than looping execution calls.

Follow the reported next action. Status distinguishes configured routes for new plans from models bound to the retained attempt. While a coder is running, `delivery_steer` can request that it prioritize its existing approved checks; direct `subagent steer` remains blocked. Runner acceptance is not proof the message was delivered or acted on. A blocked tool request delivered no steering message.

Inspect native transcript command results before describing verification. Missing `dist/` does not prove tests never ran, and gaps between tool calls do not establish why a model is slow. Report observed commands, exit results and remaining failures. A continuation should run current-task checks early and investigate their failures rather than repeat broad repository discovery.

When the approved correction round bound is exhausted and there is no owned child, reserved continuation or legacy check-order repair, `delivery_resume` may offer one compact confirmation to adopt an already higher configured bound, but only while cumulative coding time remains. Never increase the configured limit merely to escape exhaustion. That confirmation preserves the current task, routes, checks, scope, reports, retry history and coding spend; it launches no replacement plan and does not reset the round counter. If no higher preconfigured bound is available or coding time is exhausted, the execution is genuinely terminal: inspect `delivery_status`, report retained findings and wait for an explicit user decision. Do not generate another corrective plan automatically after final exhaustion. Other closed failed attempts follow the precise retained-state next action; when it explicitly requires a **new corrective plan**, preserve partial work, unfinished tasks and final checks rather than treating recovery as a reset. No saved Markdown file is required when retained task context exists.

Closed native transport failures (including `partial` runs) retry automatically on the exact approved route, at most twice per task/review round/stage, after 5 and 10 seconds. Partial changes, previous logs, review gates and consumed budgets are preserved. Do not request another approval, a route change or an initial commit for these retries.

For other non-timeout failed native workers, `delivery_resume` first confirms closure and the original model, then retains the failure receipt and coding spend without restarting execution. This is reconciliation, not a successful retry. Inspect the native error and current partial work before proposing corrections; a provider failure alone is not a code finding. A failed reviewer must not cause completed coding to be replayed. Unknown closure or model evidence remains blocked. An exhausted continuation is terminal, not permission for another automatic attempt.

A known native read-only preflight rejection can be retried through confirmation without replaying coding. Other ambiguous launches require investigation. Preserve partial files, original test evidence, reports, consumed time and final gates. Do not edit session JSON externally.

An exact native model-exclusion preflight rejection is also recoverable: `delivery_resume` closes the proven non-launch reservation while preserving its plan and evidence. Then prepare a corrective proposal, using `delivery_configure` only if the user wants different models. Repeated resume calls on a closed attempt return guidance, not another execution. Do not ask the user to abandon the session.

Before claiming completion, inspect actual checks and independent reviews. State missing evidence explicitly. No automatic commits, pushes, deployments or session sharing. These are trusted-session controls, not an OS sandbox.
