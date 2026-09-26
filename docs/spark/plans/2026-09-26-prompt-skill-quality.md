# Prompt and Skill Quality Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use spark:subagent-driven-development (recommended) or spark:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve pi-delivery worker prompt and skill quality while preserving the thin coordinator boundary.

**Architecture:** This is a documentation-contract change. Agent markdown and skill markdown become stricter about evidence, quality, scope, and blocking criteria; tests assert core clauses remain present.

**Tech Stack:** Node.js built-in test runner, Markdown prompt files, ESM tests.

## Global Constraints

- Do not change runtime orchestration semantics.
- Do not add dependencies, execution modes, optimizer passes, Git lifecycle automation, cleanup, provider fallback, or model substitution.
- Keep prompts concise enough to remain usable as agent instructions.
- Preserve read-only reviewer/security tool boundaries.
- All implementation tasks must pass `npm test`.

---

### Task 1: Harden delivery agent prompts

**Files:**
- Modify: `agents/delivery-coder.md`
- Modify: `agents/delivery-reviewer.md`
- Modify: `agents/delivery-security.md`

**Interfaces:**
- Consumes: Approved task briefing from `extensions/delivery/extension.mjs`.
- Produces: Stronger Markdown instructions consumed by pi-subagents native workers.

- [ ] **Step 1: Update coder prompt**

Add concise requirements for reading conventions first, minimal complete edits, TDD/debugging/verification discipline, exact report evidence, and genuine blocking criteria.

- [ ] **Step 2: Update reviewer prompt**

Add adversarial evidence rules: inspect actual source, validate acceptance and edge cases, treat missing evidence as uncertainty, reject shallow approvals and unrelated drift.

- [ ] **Step 3: Update security prompt**

Add explicit threat-model checklist: attacker input, trust boundaries, authn/authz, injection, secrets, dependencies, uploads, network/deploy exposure, logging leaks, exploit preconditions, impact, remediation, residual risk.

- [ ] **Step 4: Run prompt contract tests**

Run: `npm test`
Expected: PASS.

---

### Task 2: Harden delivery skills and prompt contract tests

**Files:**
- Modify: `skills/orchestrate-delivery/SKILL.md`
- Modify: `skills/security-review/SKILL.md`
- Modify: `skills/select-task-model/SKILL.md`
- Modify: `tests/documentation.test.mjs`

**Interfaces:**
- Consumes: Existing public delivery contract in README/SECURITY/docs.
- Produces: Skill guidance and tests that prevent regression of high-quality prompt rules.

- [ ] **Step 1: Update orchestration skill**

Clarify high-quality plan requirements: concrete task instructions, acceptance criteria, task-specific executable checks, evidence-based reviews, no fabricated success, thin coordinator boundary.

- [ ] **Step 2: Update security-review skill**

Align with hardened security agent prompt. Keep structured_output schema exact and read-only constraints explicit.

- [ ] **Step 3: Update select-task-model skill**

Clarify exact route selection quality: catalog availability is not capability proof, no inferred quality/price, preserve user-selected routes, route changes need displayed approval.

- [ ] **Step 4: Add documentation tests**

Extend `tests/documentation.test.mjs` with durable regex assertions for core prompt/skill concepts, avoiding brittle full-paragraph matching.

- [ ] **Step 5: Run verification**

Run: `npm test`
Expected: PASS.

Run: `npm run check:release`
Expected: PASS.
