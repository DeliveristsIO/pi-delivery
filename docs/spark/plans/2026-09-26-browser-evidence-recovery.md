# Browser Evidence Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use spark:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Execute approved browser verification through native workers and recover one conclusively closed evidence/report failure without replaying accepted coding.

**Architecture:** Extend existing sequential coordinator, not native execution infrastructure. Add strict browser/report contracts, bounded artifact receipts and typed checkpoints; retain exact native identity, closure and workspace fence. Recovery proposal is inspection-only and execution consumes fresh approval.

**Tech Stack:** Node.js ESM, node:test, existing Pi event-bus RPC; no dependencies.

## Global Constraints

- No dependencies, Git writes, commits, pushes, production access, automatic retries, model fallback or unmanaged coordinator tools.
- Read-only plans cannot probe or run verifier. Probe every declared browser contract before first coder.
- Preserve existing untracked design spec, dirty work, exact routes, closure checks and opaque boundaries.
- Verifier deliberately uses displayed coder route, fresh context and no delegation. Shell is not an OS sandbox.
- Supervisor approved: OFF safely releases retained exact lease and durably invalidates recovery; ON cannot restore eligibility. Newly approved plan required after unmanaged handoff.
- Old journals lacking typed checkpoint/closure/fence proof cannot recover.

## Context read

Read complete installed Pi `docs/extensions.md` (3,024 lines), installed pi-subagents `docs/extension-api.md`, `docs/agents.md`, `docs/observability.md`, plus repository coordinator, policy, IO, installer and native tests. Installed Pi docs resolved through pi-caveman's installed coding-agent package; standard npm coding-agent docs path absent.

## Task 1: Contracts, artifacts and recovery proof

Files: `extensions/delivery/policy.mjs`, new `extensions/delivery/evidence.mjs`, `extensions/delivery/io.mjs`, new `tests/delivery-evidence.test.mjs`.

Interfaces: optional task `browser` contract (acceptance, runner, probe, named scenarios, local/test environment, target, interaction scope, explicitly permitted artifacts); `VERIFIER_REPORT_SCHEMA`; `snapshotId(snapshot)`, `collectEvidence(directory, contract, report, identity)`. `inspectLock` checks existing exact fence without acquiring or writing.

- [x] Add schema tests: valid browser implementation, review rejection, invalid scope/target/artifact paths, typed blocked-report validation.
- [x] Add artifact tests: exact task/round/source/phase identity, command exits, permitted paths/hash, symlinks/ancestor traversal, oversize and synthetic secrets.
- [x] Run `node --test tests/delivery-evidence.test.mjs` and record expected red failures before implementation.
- [x] Implement strict contracts and bounded sanitized evidence; no arbitrary file reads. Add typed structured-report error only after native identity and closure validation.
- [x] Rerun focused tests; preserve existing native closure semantics.

## Task 2: Native verifier and normal pipeline

Files: `extensions/delivery/extension.mjs`, `agents/delivery-verifier.md`, `package.json`, `install.sh`, `tests/delivery-extension.test.mjs`, `tests/delivery-native.test.mjs`.

Interfaces: stages `probe` (all declared browser tasks before coding) and `verifier` (current source after task checks); evidence briefing includes exact commands, directory and identity; native worker uses verifier schema and coder model route. Reviewer receives sanitized receipts inline.

- [x] Add behavioral four-task ordering and missing-capability tests; assert no proposal launch, no install/fallback, read-only invariants.
- [x] Run focused tests red.
- [x] Implement stages, invalidate evidence/checkpoint on coding corrections, retain checkpoint only after accepted coder and successful checks.
- [x] Register/package/install verifier and add offline native profile/tool/schema contract test.
- [x] Run focused extension/native/artifact tests green.

## Task 3: Separately approved bounded recovery and OFF diagnostics

Files: coordinator and IO above; new `extensions/delivery/recovery.mjs` if policy extraction needed; behavioral tests above and `tests/delivery-recovery.test.mjs`.

Interfaces: `delivery_recovery_plan({browser?: BrowserContract})`, `delivery_recovery_execute({})`. Freeze original product tasks/routes; optional browser amendment scoped to current task evidence. Retain successful coder/check receipts and closure reference, typed failure reason/stage and one-attempt task/source counter.

- [x] Add failure/recovery tests: proposal never launches; new approval required; recover evidence then fresh reviews then task two through four/final checks; task-one coder/check count unchanged.
- [x] Add refusal tests for stale source/routes/fence/session/closure, pending check, unknown launch, concurrent execution, stop, correction bound, repeat recovery, old journals, OFF -> ON and stale journal replay.
- [x] Run focused tests red.
- [x] Implement inspection-only eligibility, exact lease reconciliation at execution and fresh native preflight; consume attempt/approval before await; no retry on infrastructure errors.
- [x] Implement settled OFF handoff with safe release before enabling unmanaged tools; resume observation-only, never suggest resume without known worker.
- [x] Run focused tests green.

## Task 4: Documentation and acceptance

Files: README, SECURITY, configuration/roadmap, orchestrate-delivery and role profiles, documentation tests, this plan.

- [x] Remove parent browser/Git execution promises while ON; document native evidence, schema example, recovery limitations and OFF invalidation.
- [x] Run `npm test`, `npm run check:release`, `bash -n install.sh setup.sh`.
- [x] Inspect final diff and `git diff --cached --name-only`; no staged files.
- [x] Record real outputs and unavailable live browser/provider smoke honestly. Parent owns independent reviewer gate.

## Validation evidence

Runtime implemented. Independent quality review found restart handoff and probe attribution defects; correction worker addressed both, then final review identified loss of closure evidence after recovery preflight failure. Parent reproduced that final finding with two failing real-lock tests (ping failure and unknown fleet) and preserved fenced handoff proof separately from latest failure diagnostics. Proof is cleared on successful release/new worker reservation/recovery ownership transition and revalidated before OFF. Final parent validation: `npm test` 252/252 passed; release scan errors=[]; shell syntax and diff whitespace checks passed. Security review approved the preceding revision. The final parent correction has not had another independent review; live browser/provider smoke remains unperformed.

- Red phase: `node --test tests/delivery-evidence.test.mjs` failed 3/3 for absent browser/report fields and evidence module; added implementation then 3/3 passed.
- Red phase: new browser state-machine tests failed before runtime stages/recovery tools existed; focused extension/native/policy/recovery/evidence suite later passed 135/135.
- Targeted red/green covered recovery code defects (previously replayed coder), restored OFF tools after reload (previously restricted list), unexecuted proposal OFF invalidation, and typed read-only block lease release.
- Interim full suite identified installer fixture manifest drift (new verifier absent from setup fixture); updated installer/setup resource lists, then resolved intentionally changed documentation assertions.
- Final required commands and counts are recorded in the implementation artifact; rerun after this tracking update.
- No live browser/provider end-to-end smoke performed. Offline tests exercise installed native bridge/tool-plan/closure/diagnostic contracts and synthetic browser artifacts only; no dependencies, browser downloads, production access or credentials used.
- Native compatibility limit: async native `failed` plus typed required-output absence does not prove report-only failure; provider/timeout failures also lack output. Recovery stays limited to exact native `complete`/observed-success report failures and typed closed evidence blocks. User's original failed reviewer is not claimed recoverable.
- Supervisor-approved OFF semantics: retain lease/fence on recoverable block; settled explicit OFF releases exact lease, persists invalidation and restores recorded tools. ON never restores authority. New evidence-discovered defects stop and require separately approved code correction, not current-task coder replay.
- Existing untracked spec preserved and updated only with implementation status, approved clarifications and native compatibility limit. No files staged; no repository Git writes, commits or pushes performed.
