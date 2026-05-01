# Security policy

## Supported versions

Traceworks is a young package on a rolling 0.x release cadence. Until v1.0.0 ships, only the latest minor is actively patched for security issues. After v1.0.0, the policy will widen to the latest two minors.

| Version           | Supported |
| ----------------- | --------- |
| 0.x (latest)      | yes       |
| 0.x (older)       | no        |

## Threat model

Traceworks is a thin orchestration layer over Anthropic and OpenAI SDKs. It does not run a server, does not host data, and does not phone home. The trace pipeline writes JSON to a local directory by default (`.traceworks/traces/`); the optional hosted backend is opt-in and ships nothing without an explicit configuration line.

What Traceworks explicitly does not do:

- Send anonymous telemetry. The local-first default means zero outbound traffic beyond the LLM provider call you initiated.
- Persist provider API keys to disk. Keys are read from environment variables or `traceworks.config.ts` and held in memory for the lifetime of the process.
- Execute arbitrary code from model output. Tool calls are dispatched only against tools you explicitly registered via `tool({ ... })`. The model's textual output is never `eval`'d.
- Relax provider rate limits or auth. We surface exactly the errors the provider returns; we never silently retry on auth failures.

Security-relevant invariants to preserve when contributing:

- Tool dispatch must validate model-supplied input through the registered Zod schema before invoking the user callback. A bypass would let model output reach user code untyped.
- The trace JSON format is allowed to record prompts and responses; it must never record raw API keys, even if a user includes one in a prompt by mistake. The trace writer redacts known key patterns before flushing.
- Provider adapters live behind one internal interface. A new provider may not expose its own SDK types in user-facing API; doing so would lock users into one SDK's quirks.
- The local inspector (`npx traceworks inspect`) reads the trace directory; it must never make outbound network calls beyond the LLM provider routes the user already authorized.

## Reporting a vulnerability

**Do not open a public GitHub issue.** Send a private report to **can.arslan@nodelabs.software** with:

- A short description of the vulnerability.
- A minimal reproduction: the exact code snippet, model name, and any configuration that demonstrates it.
- The Traceworks version (`npm ls traceworks` or `package.json`) and Node.js version (`node --version`).
- Whether the issue is local to Traceworks itself or involves a specific provider SDK.

Expect a reply within **5 business days** acknowledging receipt. From there:

- Triage: within 7 days of receipt, we confirm whether the report is a security issue or a regular bug.
- Fix: within 30 days of confirmation for critical issues (data leakage, key exposure, sandbox escape); best-effort for lower-severity issues.
- Disclosure: coordinated. We will credit the reporter (unless you prefer anonymity) in the patch release notes once a fix has been shipped and users have had a reasonable window to upgrade.

If you have already published a report publicly by mistake, contact the maintainer immediately so we can coordinate a patch release.

## Bug-bounty

Traceworks does not currently operate a bug-bounty program. Credit in release notes and a public thank-you are the only rewards offered.
