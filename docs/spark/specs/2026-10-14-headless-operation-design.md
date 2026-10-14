# Headless Operation Design

## Problem

Delivery can only be switched on with the interactive `/delivery on` command, and `delivery_plan` refuses to run while Delivery is OFF. A non-interactive launcher (for example an agent harness running `pi -p`) therefore cannot use the pipeline at all. Slash commands are not processed in print mode, so there is no workaround from the caller.

A second problem is lifetime. `delivery_plan` starts the pipeline as a background job and returns. In a non-interactive run the process exits after the agent's last turn; `session_shutdown` sets `closed` and the loop stops at its next gate. Auto-enabling alone would therefore start work that dies when the process exits.

## Scope

An explicit, opt-in headless mode. Nothing changes for interactive or RPC sessions, and nothing changes unless the configuration opts in.

- Config key `"headless": true` in `delivery.json` (read from `PI_CODING_AGENT_DIR` or `~/.pi/agent`, like every other key). Absent or any other value means off.
- When the key is `true` and the session has no UI, Delivery turns itself ON at session load, using the same `enable()` path as `/delivery on` (exact planning route, tool addition). Pi's `--tools` allowlist still filters afterwards, so a launcher that passes it must list the delivery tools and `subagent`; verified with a real `pi -p` status probe.
- In that mode `delivery_plan` and `delivery_recovery_plan` launch immediately (autonomous approval) and then **wait** until the run settles (`complete`, `blocked` or `stopped`, including bounded automatic continuations) and return the outcome: the short completion summary on success, the evidence text otherwise.

## Non-goals

- No new tool, no environment-variable switch, no change to routes, limits, correction rounds, review gates, commits or the never-push rule.
- No approval bypass: headless requires autonomous approval. `"approval": "manual"` cannot be satisfied without a person, so headless refuses to enable and says why.
- `delivery_configure` route changes still require an interactive UI.
- No claim of an OS sandbox.

## Safety design

- Opt-in lives in the agent directory's own `delivery.json`. An interactive user's default directory is unaffected unless they add the key themselves.
- Only sessions without a UI qualify. `hasUI` true (interactive/RPC) never auto-enables.
- Headless does not re-enable after an explicit OFF that invalidated recovery, and never for an unsupported legacy journal.
- Enabling failure (for example an unavailable planning route) leaves Delivery OFF and displays the reason; it never falls back or substitutes a model.
- The launcher's own timeout still bounds the run. If the process is stopped, existing shutdown behavior retains state for `delivery_resume` in a later session.
- Removing the human approval turn is the whole point of this mode. Whoever configures `headless` accepts that any prompt reaching that agent directory can start workers inside the displayed limits (12 tasks, two correction rounds, local commits only).

## Testing

Synthetic lifecycle tests only (stubbed native RPC): default off, opt-in on, interactive unchanged, manual-approval refusal, enable failure leaves OFF, plan waits for completion and returns the summary, blocked outcomes return instead of hanging, guidance text. Documentation tests protect the README, configuration, security and skill statements. Real provider execution remains a separate, explicitly consented step.
