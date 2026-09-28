# Browser evidence and bounded delivery recovery

Status: approved design; runtime implementation and offline regression verification recorded in the implementation plan. Live browser/provider smoke remains separate.

## Fresh continuation amendment

User-approved follow-up: missing recovery metadata must not permanently forbid new work on preserved source. For a user-requested continuation, `delivery_plan` can supersede a settled blocked/stopped run (or an unexecuted recovery proposal). It checks native fleet status and rejects live/unknown workers, pending checks, interrupted planning and unresolved lease ownership. A proven retained lease is released through the same exact handoff validation, without requiring OFF/ON. The complete old state is archived as a `delivery-superseded-v1` session entry, and the new proposal retains its predecessor identity and plan. Current files become the new baseline; receipts and approvals are not transferred. New execution requires approval of the displayed revised plan. Only its listed remaining tasks run; deciding remaining scope requires inspecting actual source, not inferring completion from failed reports. User-requested browser-test omissions must be displayed as acceptance changes and unverified behavior, never passing evidence. This is not a retry or old-journal upgrade. Legacy ownership formats and unknown worker/check closure remain fail-closed.

## Outcome

Delivery can verify an approved UI change on a headless machine and hand readable evidence to independent reviewers. A confirmed, closed evidence-related block can receive a separately approved recovery proposal that collects evidence, reruns review and continues remaining tasks without replaying accepted coding.

## Grounded failure

- `extensions/delivery/extension.mjs` restricts parent tools via both the active allowlist and tool-call hooks. Loading a browser skill cannot grant shell or browser control.
- Reviewer profiles deliberately allow only local read tools.
- `loop()` treats every structured `blocked` report as terminal. Missing structured output fails before a review verdict can be consumed.
- `resume()` only observes the retained native worker. It is not retry authority.
- Existing prompts promise browser collection and parent Git writes without a runtime handoff supporting those actions while Delivery is ON.

Prompt presence tests have passed without testing this product workflow. This change requires state-transition and native-contract tests, not just more matching text.

## Decision and alternatives

Recommended: keep the restricted coordinator, add a native evidence worker and explicit bounded recovery.

Rejected: grant unrestricted shell/browser access to the coordinator while delivery owns the workspace. This loses single-writer ownership and confuses verification with untracked execution.

Rejected: silently rerun the coder or loosen reviewer approval. This repeats accepted work or hides missing evidence.

## Evidence contract

Implementation tasks may declare optional browser verification with:

- relevant acceptance criteria and named scenarios;
- repository-local runner and capability-probe commands;
- local/test environment target and permitted interaction scope;
- explicitly approved artifact location and capture requirements.

No inference from filenames that every UI or authentication change needs production browsing. Existing server integration tests can prove server authorization, replay and expiry. Browser-driven tests prove client JavaScript, fragment transfer and navigation. Existing Capybara/Playwright tests count; screenshots are not universally required.

Read-only review plans never execute capability probes, shell checks or a browser worker. They may inspect already supplied evidence.

The declared probe must exercise the required headless runner/browser, not merely find a binary or skill file. Availability of an installed skill is not successful launch, authentication or interaction support. No automatic dependency installation or browser download. No production mutations, spending, or credential retrieval. Authorized test interaction may mutate isolated test data; no claim of an OS sandbox.

## Native evidence worker

Add `delivery-verifier` with the narrowly documented role of running approved probes and browser scenarios. It uses native pi-subagents with fresh context, no delegation, and the exact coder model route displayed in the proposal. This reuses a configured route deliberately; it is not a fallback or silent model selection.

The worker can read source and execute approved verification commands, but cannot edit application code, Git metadata, dependencies or deployment configuration. Shell is not a security sandbox: source/Git snapshots are checked before and after, and side effects remain constrained by the approved task and trust model.

Persist a run-owned artifact directory outside application source. Artifacts must be regular files under that exact directory, without symlink traversal or arbitrary absolute-path reads. Pass bounded, sanitized text evidence directly into reviewer briefings so an inaccessible external screenshot is not the only proof. Retain artifact identity/hash, task, round, source snapshot, environment, scenarios and command exit results. Artifacts from an earlier source revision do not approve a later correction.

Do not capture raw cookies, credentials, child-login tokens, token-bearing URLs, or unredacted traces by default. Redaction is defense in depth, not a guarantee that arbitrary browser output is safe. Capture only explicitly permitted data; keep raw traces disabled unless separately authorized and reviewed.

## Normal execution

After plan approval and existing ownership/native preflight:

1. Run declared capability probes for tasks requiring browser evidence before the first coder launch. Execute nothing during proposal display.
2. On probe failure, report the specific missing capability and stop before implementation; no install or fallback.
3. Run coder, then task checks as today.
4. Run declared browser scenarios through the verifier for the current source revision.
5. Pass verified evidence receipts and sanitized artifacts to fresh quality/security reviewers.
6. Proceed to later tasks and final checks only after required reviews pass.

Coder corrections invalidate current browser evidence and rerun checks/verification/review. Existing correction limits remain. No extra background execution loop.

## Explicit recovery, not resume

Introduce a recovery proposal tool and a distinct execution tool. Proposal is inspection-only; it cannot launch. Display exact retained run/task, source snapshot, approved remaining tasks, model routes, new evidence commands, work already accepted, and reviews/checks that will be rerun. Execution requires a new explicit approval turn bound to that unchanged proposal.

Eligibility requires all of:

- exact repository/session/run and current journal fence;
- no live or unresolved native worker or pending host check;
- validated native process-tree closure and reconciled lock ownership;
- retained successful coder report and task-check receipts for the same unchanged source;
- a recoverable evidence/review-report failure classification, not arbitrary error-message matching;
- no stop request, unresolved code defect, exhausted correction budget, or unknown launch;
- unchanged exact routes and approved product requirements.

Recovery executes evidence collection, fresh quality review, conditional security review, then remaining tasks and final checks. It does not replay the accepted coder or reuse a superseded review approval. Evidence-only recovery is limited to one attempt per task/source revision; another failure preserves evidence and stops. Infrastructure failures never automatically retry.

Malformed reviewer output requires verified reviewer closure before a separately approved fresh review may run. It never counts as an approved verdict. Source changes during any recovery invalidate eligibility rather than silently rebasing receipts.

New journals retain typed failure stage/reason, checkpoint identity, closure reference and recovery attempt count. Old journals are not silently upgraded into recovery eligibility. Where existing evidence cannot prove eligibility, explain exactly which proof is absent; do not claim this feature can recover every previously blocked run.

`delivery_resume` remains observation-only. Status suggests it only when a retained worker actually exists. A recoverable closed block instead points to the recovery proposal; unavailable capability names the required prerequisite; unresolved ownership points to inspection.

## Documentation and tool consistency

Update skills, agent profiles, README, SECURITY and roadmap together. Remove promises that a parent can browse or write Git while Delivery is ON. Existing `/delivery off` remains an explicit handoff only after closure/ownership checks; this feature does not automatically disable delivery or introduce Git publishing. Durable specs required for substantial work are not contradicted by the tool accepting an inline plan.

Register/package/install the verifier and any new runtime modules. Keep exact model bindings, read-only review mode, dirty-work preservation and opaque nested-repository boundaries.

## Acceptance tests

1. A four-task plan runs preflight, coder, task checks, browser verification, quality/security review, remaining tasks and final checks in order.
2. Missing browser capability stops before the first coder; no browser installation or replacement launch occurs.
3. A valid closed evidence block can be proposed for recovery without launching; only fresh approval starts evidence/review and task two. Task-one coder count stays unchanged.
4. Browser evidence is readable by read-only reviewers without browser/shell access.
5. Wrong revision, changed routes, foreign worker/session, stale fence, missing closure, pending check, concurrent recovery and unknown launch all refuse execution.
6. Missing/malformed reviewer reports never approve work; observed closure plus explicit recovery approval permits one fresh review.
7. Recovery stops at its bound and cannot bypass exhausted correction limits or stop requests.
8. Artifact traversal, symlinks, oversized files and mismatched identities fail closed. Secret-bearing synthetic captures exercise sanitization without live credentials.
9. Read-only review and non-browser plans retain existing behavior. Existing native recovery, issue research and snapshot tests remain green.
10. An offline native-contract test verifies the verifier tool/profile and structured-report contract. Synthetic passes are not claimed as live browser or provider verification.

## Implementation sequence

1. Schema, typed failure/checkpoint and recovery-policy tests.
2. Verifier profile, capability probes, artifact handling and packaging tests.
3. Normal execution integration and evidence handoff tests.
4. Explicit recovery proposal/approval/execution and identity/race tests.
5. Status/tool guidance, documentation alignment, independent quality/security review.

Verification: `npm test`, `npm run check:release`, `bash -n install.sh setup.sh`, then an explicitly authorized headless end-to-end smoke in an isolated fixture environment. Record unavailable live capabilities honestly.

## Approved implementation clarifications

- Recovery tools are `delivery_recovery_plan({browser?: BrowserContract})` and `delivery_recovery_execute({})`. Amendments are current-task evidence only; existing environment/target/interaction scope cannot expand. Product tasks and routes remain frozen.
- Recoverable closed blocks retain the workspace lease/fence. Explicit settled OFF safely releases that exact lease, persists recovery invalidation, then restores original tools. ON/reload cannot revive eligibility; managed work requires a newly approved plan. No separate recovery fence survives unmanaged handoff.
- A new code defect discovered during evidence-only recovery stops with retained findings; no current-task coder replay, later task advancement or final checks. Separately approved scoped correction is required. Later tasks, when legitimately reached, retain normal bounded corrections.
- Binary artifacts are hash-addressed receipts; bounded sanitized text is handed inline to reviewers. Native verifier receipts are structured worker evidence, not an OS-level command-execution attestation. Raw capture remains restricted and private; sanitization is not exhaustive.

Native compatibility limitation: installed async pi-subagents can mark missing `structured_output` as native `failed`. Its typed `effects.settlementDiagnostic.requiredOutput.missing` records absence but does not prove that absence was the sole failure (provider/timeout failures can also lack output). Delivery therefore does **not** recover native failed outcomes from this field or error text. Missing/malformed report recovery currently requires native `complete`, exact identity/model evidence and observed successful closure. No claim is made that this repairs any particular previously failed reviewer or old journal.
