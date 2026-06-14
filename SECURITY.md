# Security Policy

## Why this repository is public

`public-workflows` holds **reusable GitHub Actions workflows** that are called by both
public and internal `praetorian-inc` repositories. GitHub only allows a **public**
repository to call a reusable workflow that lives in another **public** repository — a
public caller cannot reach a private/internal one. Because public repos (e.g. `titus`,
`brutus`, `nerva`, `pius`, `hadrian`, `julius`, …) depend on these workflows, this
repository **must** be public.

Publishing CI configuration is safe **by design, not by obscurity**: the workflows here
contain no secrets (only secret *names*, resolved at runtime by the caller), and they are
hardened so that reading them reveals no exploitable path. Hiding insecure CI would not
make it secure — it would only delay discovery. We instead keep the configuration correct
and auditable.

## Threat model & controls

These workflows run untrusted PR content (AI reviewers) and hold push/release credentials
(version + release automation). The controls that keep "public" safe:

| Threat | Control |
| --- | --- |
| **Pwn request** (privileged trigger + untrusted checkout + secrets) | No workflow checks out PR `head`. AI reviewers trigger on `pull_request` (fork PRs get a read-only token and **no secrets**), never `pull_request_target`. Privileged automation (`changelog-scan`) allowlists `schedule`/`workflow_dispatch` only and refuses every other event. |
| **Script injection** (`${{ github.event.* }}`/`inputs.*` into `run:`) | Untrusted/templated values are bound to `env:` and referenced as shell variables, never interpolated directly into `run:`. |
| **Over-privileged token** | Default `permissions:` are least-privilege and job-scoped; `contents: write` is granted only to the specific jobs that push tags/commits/releases. |
| **Credential leakage** (`artipacked`) | `persist-credentials: false` on every checkout that does not itself push. The few checkouts that *do* push use a scoped GitHub App token and are annotated `# zizmor: ignore[artipacked]` with rationale. |
| **Supply chain** | Every `uses:` is pinned to a full 40-char commit SHA (enforced by `verify-pins.yml` and the self-audit gate). |
| **Cache poisoning** | Caching is disabled in release jobs (an immutable-tag build must not consume a cache writable by a less-privileged workflow). |
| **Egress / exfiltration** | Sensitive jobs run `step-security/harden-runner` with `disable-sudo-and-containers` and, for the highest-privilege job, `egress-policy: block` with a host allowlist. |

## Self-enforcement

Every PR to this repo runs `self-audit.yml`: **zizmor** (workflow security scanner) +
**actionlint**. A new High-severity finding blocks the merge. `.github/CODEOWNERS`
additionally requires Security Engineering review on any change under
`.github/workflows/`.

## Reporting a vulnerability

Email **security@praetorian.com** with details. Please do not open a public issue for
suspected vulnerabilities in these workflows.
