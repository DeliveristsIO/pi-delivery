---
name: select-task-model
description: Use when selecting or escalating OpenAI or Ollama Cloud models for coding, review, security, or repository research tasks.
---

# Select task model

Choose by task evidence, not names or assumed prices. Keep the approved routes in the feature plan; no routing database or custom runtime is required.

1. Classify role, complexity, security risk, required tools, context and permitted data boundary. Ollama Cloud is remote, not local/private execution.
2. Inspect the actual model catalog. Copy exact `provider/model` IDs. Availability is not successful inference or qualification.
3. Prefer models with relevant tool-use, correctness and review evidence. Compare cost per accepted task including retries, review, latency, caching and subscription quota. Unknown cost stays unknown; Ollama is not automatically cheaper than GPT.
4. Research/design preference is `openai-codex/gpt-6-astra`; verify availability. This preference is not a benchmark result.
5. Explain each role and available model metadata (context/output limits, reasoning, input types and catalog pricing). Missing evaluation evidence is a disclosed uncertainty, not an attestation question or execution gate. User-approved exact routes may be used with plan approval, tests and independent review; sensitive changes require security review. Unapproved routes remain **BLOCKED**.
6. Pass the approved exact model on every dispatch. Profiles intentionally omit model defaults: never dispatch them by inheritance. No silent fallback. One fresh independent review session per stage; a different model is useful when evidence supports it, not mandatory by name.
7. Failed runs need diagnosis, narrower scope or a newly approved model. Stop after the plan's retry limit (default two fix/review rounds); do not retry indefinitely or automatically escalate to Astra.

Record briefly in the plan: role → exact model, relevant evidence or uncertainty, data boundary, approval, limits and escalation condition. Report actual checks and costs/latency when available. No claim of “best,” “cheapest,” or “qualified” without supporting evidence.
