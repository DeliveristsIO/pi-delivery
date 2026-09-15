# Tests

Run `npm test` from the checkout. Tests use isolated fixtures and do not start model inference or application workers.

Coverage includes approval binding, exact routes, task/final check separation, bounded timeout recovery, refusal of ambiguous launches, read-only review recovery, source/workspace fingerprints and real Bash installer behavior. Installer cases cover relocation, collisions, ancestor blockers and preflight race handling. Bootstrap cases drive the real `setup.sh` against a stubbed `pi` to assert pinned package installs (with npm lifecycle scripts ignored) before linking, rerun idempotency, conflict reporting and the loading-check paths.

The reviewer-prompt test additionally executes the installed pi-subagents task-intent classifier unchanged when it is available under the normal agent package directory or `PI_SUBAGENTS_DIR`. Without that optional installation, deterministic prompt-contract tests still run; native classifier coverage is not implied.

```bash
node tests/check-installed.mjs /path/to/trusted/repository
```

This optional loading check starts a disposable Pi process, queries commands/status, and exits. It does not request inference, resume a saved application session or dispatch workers. It requires an existing Pi installation and installed delivery links.

A passing synthetic suite does not prove provider availability or successful application delivery. Real worker checks require explicit model/provider consent and disposable fixtures. Keep their private receipts outside published files.
