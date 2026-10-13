# Tests

Run `npm test`. Tests use isolated fixtures, stubbed native RPC execution and actual filesystem/process checks; no model inference or real application workers are launched. Installer/bootstrap tests retain their no-clobber, ordering and privacy safeguards.

When pi-subagents is installed, an additional no-inference test imports its real RPC bridge and tool-plan resolver, exercising a stub executor and the packaged read-only profiles. It is skipped explicitly when the package is absent.

Coverage includes approval/non-launch, exact routes, task/final ordering, independent review, bounded corrections, malformed results, unknown launch refusal, cancellation/reload, dirty workspace preservation, read-only Git, schemas and profile tool allowlists. Removed engine-only suites covered intentionally deleted Git lifecycle, cleanup, optimizer and recovery/migration features; essential safeguards now live in the small lifecycle/I/O/policy suites.

```bash
node tests/check-installed.mjs /path/to/trusted/repository
```

This optional check starts ephemeral offline Pi, queries commands/status and exits without inference, workers or a saved-session resume. It requires existing installed links. When invoked from a subagent shell, use `PI_SUBAGENT_CHILD=0 node tests/check-installed.mjs ...` only for this isolated probe; ordinary child sessions intentionally do not register the coordinator.

Synthetic tests and loading checks are not evidence of successful provider end-to-end operation. That requires separate explicit consent. Keep private receipts outside the repository.

## Incident replays

`tests/fixtures/incidents/evidence-outcomes.json` contains sanitized, provenance-tagged scenarios replayed by `delivery-extension.test.mjs` through its existing isolated harness. Reports and check exits are scripted; assertions cover durable terminal state, exact worker sequence, check receipts and whether a completion message was emitted. A successful control ensures completion is still possible. No inference or workers run live.

Current failure fixtures are **reconstructed contract scenarios**, not production transcripts. For a new incident, capture only the minimal sanitized reports/check outcomes needed to reproduce it; identify the source and mark whether it is an actual sanitized incident or a reconstruction. Never include credentials, private repository paths, or raw user transcripts. Add the failing replay before the fix, including forbidden launches or completion claims. Extend the existing harness only when the incident needs an additional scripted effect; do not create a separate execution engine. These replays verify coordinator behavior, not model quality or live provider reliability.
