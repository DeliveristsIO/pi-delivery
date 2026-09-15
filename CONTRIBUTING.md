# Contributing

Use Node.js 24+, Bash and GNU coreutils. No npm dependency installation is required for unit tests.

```bash
npm test
bash -n install.sh
```

Follow SPARK's debugging, TDD and review practices. Reproduce a bug before patching it; keep changes focused. Preserve model bindings, workspace checks, original evidence and native worker ownership. Never broaden reviewer tools to work around a routing error.

Layout:

- `extensions/delivery/`: runtime, policy, IO, RPC, schemas and setup.
- `agents/`, `skills/`: installed delivery resources.
- `install.sh`: offline, conflict-safe linking.
- `tests/`: synthetic controller, filesystem and installer regressions.
- `docs/`: public configuration, roadmap and release guidance.

Use synthetic examples. Do not add real session logs, credentials, customer source, private issue text or machine-specific receipts. Keep local investigation artifacts in ignored `.spark/` storage, outside publication contents.

Independent review should inspect actual code and recorded checks, not trust a worker's success claim. Record tests not run and unresolved findings. Avoid automatic commits or remote actions unless explicitly authorized.
