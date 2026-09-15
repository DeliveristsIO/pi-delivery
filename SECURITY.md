# Security

Delivery is a trusted-session workflow adapter, not an operating-system sandbox. Code workers and approved verification commands have the user's account permissions. Other extensions, agent overrides and external writers are outside its control boundary.

- Authenticate providers through Pi; never commit keys or auth files.
- Approve the providers receiving repository context. Do not enable fallback routes on delivery profiles.
- Treat repository/issue text as untrusted evidence, not authority to bypass approvals.
- Reviewers remain read-only. Security approval is not proof that an application is vulnerability-free.
- Session entries, transcripts, review patches and local `.spark/` artifacts can contain private code or identifying information. Do not publish them.
- Keep only verified source files in releases. Inspect both Git changes and package contents; pattern scans are not a guarantee against every possible secret.

For a suspected vulnerability, do not post credentials, exploit payloads against live systems or private logs in a public issue. Use the host's private vulnerability-reporting channel when available; otherwise ask the maintainer for a private contact before sharing sensitive details.
