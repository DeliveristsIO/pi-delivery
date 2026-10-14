# Headless Operation Implementation Plan

**Goal:** Let a non-interactive Pi session use the delivery pipeline when the configuration explicitly opts in.

**Architecture:** Two small changes in `extensions/delivery/extension.mjs`: auto-enable in `loadSession` for UI-less sessions when `headless` is `true`, and make `launchIfAutonomous` wait for the settled outcome in that mode. Design: `docs/spark/specs/2026-10-14-headless-operation-design.md`.

## Global Constraints

- Opt-in only; default behavior and every interactive path are unchanged.
- No new tools, dependencies, routes, limits or approval bypass.
- All checks stay green: `npm test`, `bash -n install.sh setup.sh`, `npm run check:release`.
- No real provider/model execution without separate explicit consent.

### Task 1: Failing lifecycle tests

**Files:** Create `tests/delivery-headless.test.mjs`

- [ ] Default config with `hasUI:false` stays OFF and `delivery_plan` refuses.
- [ ] `headless:true` with `hasUI:false` turns ON, selects the planning route and adds delivery tools.
- [ ] `headless:true` with `hasUI:true` stays OFF.
- [ ] `headless:true` with `"approval":"manual"` stays OFF and displays the reason.
- [ ] Unavailable planning route leaves OFF with a displayed reason.
- [ ] Headless `delivery_plan` returns only after `complete`, with the completion summary, without `delivery_execute` or an approval turn.
- [ ] A blocked run returns the blocked evidence instead of hanging.
- [ ] Guidance text announces that the call waits.
- [ ] Run `node --test tests/delivery-headless.test.mjs`; confirm each fails for the expected reason.

### Task 2: Implement

**Files:** Modify `extensions/delivery/extension.mjs`

- [ ] Add `headlessEnabled()` and `isHeadless()`.
- [ ] Auto-enable in `loadSession` with the refusal/failure displays.
- [ ] Wait for settle in `launchIfAutonomous` and return summary/evidence.
- [ ] Add the headless sentence to the `before_agent_start` guidance.
- [ ] Re-run the new tests, then `npm test`.

### Task 3: Documentation and protections

**Files:** Modify `README.md`, `docs/configuration.md`, `SECURITY.md`, `skills/orchestrate-delivery/SKILL.md`, `tests/README.md`, `tests/documentation.test.mjs`

- [ ] Document the key, requirements, refusal cases, wait semantics and trust trade-off.
- [ ] Add documentation assertions for those statements.
- [ ] Run `npm test`, `bash -n install.sh setup.sh`, `npm run check:release`.
