# Contributing

Keep delivery thin: SPARK supplies methodology, pi-subagents owns native execution, and this extension only binds approval/routes/context, progresses required gates and reports evidence. Prefer deletion over configurable workflow machinery. No dependencies or model-backed fixtures are needed for the test suite.

Before changing native RPC handling, inspect the installed pi-subagents schemas, normalizer, RPC bridge and lifecycle artifacts; prose references may lag source. Add failing regressions for approval, duplicate launch prevention, terminal evidence, read-only reviews and check ordering before implementation.

```bash
npm test
bash -n install.sh setup.sh
npm run check:release
```

Keep installer/release safeguards and package allowlists consistent. Remove tests only when the feature is intentionally removed, replacing essential safety coverage with lifecycle tests. Historical `docs/spark` plans/specs are records, not current runtime instructions. Never add session files, credentials, private paths or local reports to the package.

A no-inference loading check is described in [tests](tests/README.md). Provider/model execution requires separate explicit consent. Report exact commands, results and limitations; passing synthetic tests do not prove live delivery.
