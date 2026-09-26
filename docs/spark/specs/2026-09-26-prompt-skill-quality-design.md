# Prompt and Skill Quality Upgrade Design

## Goal

Improve pi-delivery output quality by hardening existing prompts and skills without expanding the thin coordinator into a larger execution engine.

## Scope

Update only prompt/skill text and regression tests that protect those contracts:

- `agents/delivery-coder.md`
- `agents/delivery-reviewer.md`
- `agents/delivery-security.md`
- `skills/orchestrate-delivery/SKILL.md`
- `skills/security-review/SKILL.md`
- `skills/select-task-model/SKILL.md`
- Prompt/skill documentation tests under `tests/`

No runtime orchestration changes, new execution modes, optimizer passes, Git lifecycle automation, cleanup, provider changes, or dependency additions.

## Design

### Coder prompt

Strengthen implementation expectations around:

- Understanding existing conventions before edits.
- Keeping changes minimal but complete for the approved task.
- Using TDD/debugging/verification discipline when tests or behavior fail.
- Preserving unrelated dirty work.
- Reporting exact changed files, check evidence, limitations, and unresolved issues.
- Blocking only on genuine ambiguity, destructive actions, dependencies, credentials, or unauthorized product/architecture decisions.

### Reviewer prompt

Make the reviewer more adversarial and evidence-driven:

- Inspect actual source and changed paths, not coder claims.
- Validate acceptance criteria, edge cases, regressions, and test coverage.
- Treat missing evidence as uncertainty, not approval.
- Reject shallow approvals, unrelated changes, unauthorized dependencies, and behavior drift.
- Require concrete file/line findings with severity and fix guidance.

### Security prompt

Deepen security review checklist:

- Trace attacker-controlled input and trust boundaries.
- Check authn/authz, injection, secrets, dependencies, uploads, network calls, deployment exposure, and logging leaks.
- Include exploit preconditions, impact, remediation, residual risk, and inaccessible evidence.
- Avoid running commands, exploits, or retrieving credentials.

### Skills

Update orchestration and review skills to reinforce:

- Thin coordinator boundaries.
- High-quality task instructions and acceptance criteria.
- Task-specific executable checks for implementation plans.
- Evidence-based reports and no fabricated success.
- Exact model route discipline.
- Security-sensitive routing and review triggers.

### Tests

Add or extend documentation tests to assert key prompt clauses exist. Tests should prevent accidental removal of core quality rules without coupling to exact prose too tightly.

## Acceptance

- Agent prompts include explicit quality, evidence, and blocking criteria.
- Skills guide users toward better plans/reviews without promising unsupported runtime features.
- Tests cover critical prompt/skill clauses.
- `npm test` passes.
- `npm run check:release` passes if available in current environment.

## Risks

- Overly long prompts can dilute instructions. Mitigation: keep edits concise and priority-oriented.
- Prompt wording could imply unsupported engine capabilities. Mitigation: preserve roadmap boundary and avoid runtime promises.
- Tests could be brittle. Mitigation: assert durable concepts, not full paragraphs.
