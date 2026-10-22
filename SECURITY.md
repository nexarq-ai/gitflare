# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately with **Report a vulnerability** on the repository's Security tab, on Gitflare or GitHub, including:

- what an attacker can do and the affected version or commit;
- steps to reproduce or a proof of concept;
- any suggested fix.

For the hosted service at gitflare.io, you can also email security@gitflare.io. Do not include credentials or other people's data in the report.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | 3 business days |
| Assessment and severity | 7 days |
| Fix for critical and high severity | 30 days |
| Public disclosure | when a fix ships, and no later than 90 days after the report unless we agree otherwise |

We credit reporters in the advisory unless you ask us not to.

## Safe harbor

We will not pursue legal action for research that follows this policy: test only against your own installation or your own account, do not access or change other people's data, avoid degrading the service, and give us time to fix the issue before disclosing it.

## Scope

In scope: authentication and sessions, workspace and repository authorization, task-agent credential isolation, the Git and preview proxies, approval and landing integrity, and MCP authorization.

Out of scope: vulnerabilities in Cloudflare services themselves (report those to Cloudflare), denial of service through your own account's quotas, and findings that require a compromised administrator account.
