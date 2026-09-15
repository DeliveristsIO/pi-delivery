---
name: orchestrate-delivery
description: Use when coordinating approved development through the installed delivery extension and its independent reviews.
---

# Delivery coordination

Use SPARK for research, debugging, design, TDD and verification. Use the installed delivery extension for approval bindings and native worker lifecycle. Do not create a second dispatch loop.

## Prepare

Read repository instructions and relevant project memory. Resolve genuine scope questions using the appropriate SPARK skills. Select the intended workspace before activating delivery; automatic Git branching/committing is not implemented.

If delivery tools are missing, request installation and a full Pi restart after workers settle. Do not pretend workers ran. `/delivery setup` selects exact routes and obtains provider-context consent. Never silently substitute models.

## Propose and execute

- For a new proposal, call `delivery_plan` with coherent tasks, acceptance criteria, file scope and executable checks. Put current-task checks in `tasks[].checks` and release gates in top-level `checks`.
- For an existing Markdown plan, use `delivery_execute` with `planFile`, read the returned source document and derive its tasks with `delivery_plan` using the same path. Preserve its boundaries and constraints.
- A new proposal needs a fresh real user approval before `delivery_execute`. Questions, rejection and approval of an earlier proposal are not permission for the current candidate. The unchanged explicitly requested source-document flow retains its own bound authorization.
- Let delivery own dispatch and progression. Do not call unmanaged subagent execution tools or grant write tools to reviewers.

## Recover safely

Use `delivery_status` for retained state and `delivery_resume` for supported recovery. Never replay an unknown launch or reset exhausted rounds merely because the user said “continue.” If no proposal is pending, submit a corrected proposal before requesting approval; do not loop on execution calls.

When review rounds are genuinely exhausted and there is no owned child, reserved continuation or legacy check-order repair, the old execution is terminal—not a locked repository. Read the retained requirements and latest findings in `delivery_status` and prepare a **new corrective plan** with `delivery_plan`. Preserve partial work, unfinished tasks and final checks. No saved Markdown file is required. Show that proposal, then obtain fresh approval before execution. This does not reset or automatically replay the exhausted execution. Do not demand a harness reset or keep acknowledging approval without proposing the correction.

For a non-timeout failed native worker, `delivery_resume` first confirms closure and the original model, then retains the failure receipt and coding spend without restarting execution. This is reconciliation, not a successful retry. Inspect the native error and current partial work before proposing corrections; a provider failure alone is not a code finding. A failed reviewer must not cause completed coding to be replayed. Unknown closure or model evidence remains blocked. An exhausted continuation is terminal, not permission for another automatic attempt.

A known native read-only preflight rejection can be retried through confirmation without replaying coding. Other ambiguous launches require investigation. Preserve partial files, original test evidence, reports, consumed time and final gates. Do not edit session JSON externally.

Before claiming completion, inspect actual checks and independent reviews. State missing evidence explicitly. No automatic commits, pushes, deployments or session sharing. These are trusted-session controls, not an OS sandbox.
