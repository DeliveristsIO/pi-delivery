---
name: select-task-model
description: Use when selecting explicit provider/model routes for planning, coding, combined review or security review.
---
# Exact model routes

Inspect the installed model catalog and preserve existing user-selected routes. Availability is not successful inference, quality proof, price proof or task qualification. Never select a model silently or infer speed, quality, reasoning strength, input support, context size or price from its name. Explain only observed catalog facts: provider/model ID, context/output limits, input support, reasoning setting and known catalog price; unknown price stays unknown. Remote providers receive task context; Ollama Cloud is not local execution.

Delivery uses planning, coder, quality (combined specification/quality), and security. The legacy spec route and other old settings are retained but do not control execution. Every native launch carries the exact approved provider/model ID with fresh context. A separate reviewer session supplies independence; a different model is optional, not inferred.

Use `/delivery setup` or confirmed `delivery_configure` for user-requested changes. Route changes require a new displayed approval before implementation. There is no fallback, escalation, optimizer or profile selection. A failed route stops for diagnosis; do not substitute another model, claim provider end-to-end success from catalog availability, or treat synthetic tests as proof of delivery quality.
