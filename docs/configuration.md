# Configuration

Run `/delivery setup` rather than copying another person's configuration. Choose five exact `provider/model` routes: `planning`, `coder`, `spec`, `quality`, `security`. Providers and credentials are configured through Pi separately.

The installer never writes configuration or authentication. Delivery configuration lives in `$PI_CODING_AGENT_DIR/delivery.json`, defaulting to `~/.pi/agent/delivery.json`. Repository opt-ins are local canonical paths and should not be committed.

Optional timeout values, in milliseconds:

```json
{
  "timeouts": {
    "coderMs": 2700000,
    "continuationMs": 900000,
    "reviewMs": 900000,
    "idleWarningMs": 300000,
    "deadlineWarningMs": 300000
  }
}
```

This is a timeout fragment, not a complete configuration. Each value must be a whole millisecond count between one minute and two hours; `continuationMs: 0` disables continuation. Coder attempts and review fixes share the cumulative per-task allowance. Route/budget changes require reapproval where they affect retained execution bindings.

Task commands belong in `tasks[].checks`; whole-change release gates belong in top-level `checks`. Multi-task implementation plans require per-task checks. Commands run with the user's permissions; executable/syntax validation is not a shell sandbox.

Git and remote issue-action configuration is not implemented yet. Do not add speculative keys expecting them to grant permissions.
