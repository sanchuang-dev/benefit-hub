# Benefit Hub — AI Review Profile

Organization: `sanchuang-ai-review-policy/v1`.
This profile supplements the organization's read-only PR reviewer and does **not** grant merge, close, deploy or release authority.

## Highest-impact review surfaces

- Vendor A/B/C signing must use sorted nonempty canonical fields and uppercase SHA-256 hex `X-Sign`; D uses a distinct HMAC-SHA256 Base64 `X-Signature`. Verify timestamp units and that neither API secret reaches client code, logs or traces.
- `code=0` is not proof of fulfillment: B requires `allClaimed`, D needs a verified terminal `dispatchStatus`, A/C may remain user-claimable.
- Business order idempotency, original `requestId`/ `partnerOrderNo` reuse, and no blind retry after unknown external side effects.
- SQLite persistent volume, DB uniqueness/transaction boundaries, native driver image compatibility, backups, schema migration safety and downgrade behavior.
- Protected admin login, operation audit, mobile number redaction, CSRF and secure session handling; public API caller authorization.
- Workflow trust boundaries: no running PR-controlled code with secrets; immutable reusable workflow pins; worker's trusted verification must check actual changed code; worker cannot merge, deploy or close Issues.
- Branch/deployment exception: `feat/* -> dev`; no feature-branch deploy. `dev` may deploy Benefit Hub only and may not overwrite any `proto-infra` host site/configuration.
- Docker: only bind loopback, run non-root, data survives image rollback and restart.

## Review scope

Review the **PR delta**, prioritize P0–P2 actionable defects with supporting location and verification. Do not invent external API behavior beyond the supplied provider contract.

## Verification gaps

- No real provider issue/fulfillment success without current upstream sandbox/production evidence.
- No claim of real Docker build, data retention, host status, TLS or runtime health without exact-commit and actual-environment verification.
- The repository initially lacks pnpm workspace, app code and lockfile; a placeholder Dockerfile does not constitute a passing build.
