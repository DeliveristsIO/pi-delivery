# Planned work

These are requirements, not implemented features or configuration keys.

## Git and issue hosts

- Reuse a suitable feature branch or create one before implementation.
- Produce small verified commits of delivery-owned changes only; preserve unrelated edits.
- Bind reviews to recorded base/HEAD ranges, including committed work.
- Host-neutral issue references and adapters, initially GitHub and Codeberg/Forgejo.
- Configure push, PR creation, issue updates and closure separately: automatic, confirm or disabled, with global defaults and repository overrides. Default remote writes to confirmation.
- Preserve durable progress and avoid replaying completed tasks after restart.

## Efficiency

- Right-sized tasks and concise file-based handoffs.
- Focused repeat reviews, retaining independent review and final whole-change coverage.
- Preserve original failing-test evidence rather than rerunning large suites merely for narration.
- Clear timing and loaded-version diagnostics.
- Evaluate parallel read-only work without overlapping writers or weakening gates.

Keep the implementation small and aligned with SPARK; do not build a parallel methodology runtime.
