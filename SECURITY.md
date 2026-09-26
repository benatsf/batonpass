# Security policy

Report vulnerabilities privately through GitHub's "Report a vulnerability" (Security → Advisories) on this repository. Do not open a public issue. Include the version (`baton --version`), your OS, and steps to reproduce with synthetic data only; never attach a real transcript or ledger.

In scope: secrets that survive redaction, anything written outside `~/.baton` other than the files `baton install` lists, injected context escaping its `<baton-context>` wrapper, hooks that fail or block a session, and any network call other than the ones in docs/privacy.md.

You should get a reply within 7 days.
