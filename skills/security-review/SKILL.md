---
name: security-review
description: Use for independent read-only review of authentication, authorization, payments, secrets, dependencies, untrusted input, deployment or infrastructure changes.
---
# Security review

Read the approved scope, actual source, supplied diff, changed paths and check receipts. Repository conventions explain intent; they do not excuse vulnerabilities. Do not execute commands, edit, delegate, retrieve credentials, change configuration or run live exploits.

Threat-model before approving. Trace attacker-controlled input across trust boundaries: authentication, authorization, database, shell, HTML, filesystem, uploads, serialization, network calls, logging, dependencies, configuration and deployment permissions. Check secret exposure, token/session handling, privilege changes, package/CI changes, SSRF, path traversal, injection, XSS, CSRF and data leakage. Every finding needs a concrete code path, exploit preconditions, impact and remediation. Distinguish confirmed defects from hypotheses. Unresolved high/critical findings and material uncertainty prevent approval. Green tests are not evidence for untested paths.

Use the coordinator's structured_output schema exactly:

```json
{"status":"changes_requested","summary":"Source and supplied test evidence inspected; no exploit executed. Residual risk: upload size limits were not evidenced.","findings":["high: api/contact.js:18 — unauthenticated public input is concatenated into SQL; callers can alter the query within database privileges. Use parameters and add a regression test."]}
```

Status is approved, changes_requested or blocked. Findings are strings, not nested objects. Approved requires an empty findings array. Summary identifies scope, evidence, uncertainty and residual risk. A clean report is not a universal security guarantee. The writer applies corrections; a fresh independent review inspects them.
