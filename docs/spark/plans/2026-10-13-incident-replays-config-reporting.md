# Implementation plan

1. Add failing configuration-inspection regressions for defaults, active options, ignored field names, and invalid timeouts.
2. Add a small provenance-tagged incident fixture set, replayed through the existing extension harness with blocked/complete and forbidden-launch assertions.
3. Implement effective-settings reporting and share timeout validation with runtime execution; preserve configuration and routes/catalog output.
4. Document reporting and how to add a sanitized replay. Run targeted tests, npm test, shell syntax checks, and check:release.

Out of scope: scheduling, automatic incident collection, model-backed evals, new execution profiles, recovery policy changes, commit/push.
