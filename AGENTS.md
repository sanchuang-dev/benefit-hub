# Benefit Hub — repository engineering contract

Before work, read current `sanchuang-dev/.github/AGENTS.md` on main and the active task contract.

## Purpose and source of truth
- Public TypeScript monorepo for Yangmao benefit-provider adapter, own internal benefit API, and small operations console.
- `design.md` is strictly UI/visual design. Technical architecture is in `docs/architecture.md`, operations in `docs/operations.md`.
- No production secrets, issued codes, user records, or SQLite files in Git.

## Phase-one branch exception
- Explicit owner-approved project branch model: `feat/* -> dev`. `dev` is the sole integration and deployment source for the company Aliyun machine; no extra test/prod branches now.
- Feature PRs run checks but **never deploy**. Only accepted code merged into `dev` may deploy after server preflight and runtime safety checks.
- Do not change the independent `sanchuang-dev/proto-infra` static-site deployment policy or replace its Caddy configuration.

## Selected stack
Node.js 22, TypeScript strict, Hono, pnpm workspaces, React/Vite/Ant Design, React Router, TanStack Query, Zustand, SQLite + Drizzle. One Node app container serves Hono and compiled admin assets; host Caddy owns TLS.

## Correctness and security
- Supplier A/B/C use X-Sign and D uses X-Signature; never mix algorithms or log credentials.
- Business order IDs are stable with DB uniqueness constraints. Timeout/unknown outcome is **not** permission to repeat an external grant blindly.
- B requires allClaimed, D requires verified terminal dispatch state; code=0 alone is not delivery success.
- No open DB transaction across supplier HTTP calls. Monetary amounts use integer minor units; pack quota and monetary balance stay separate.
- SQLite is on persistent /data volume, outside the image. Deploys and rollbacks must never delete it or auto-downgrade schema.
- Respect provider contracts; credentials live server-side, never in browser bundle.

## Verification
For changes involving signing, persistence, credentials, schema or deployment: require independent contract tests and exact-commit evidence. Docker image builds and real runtime health must be verified before claiming deployment. No green-by-mock or disabled checks. Host inspections precede port allocation, Docker installation or Caddy edits.

## Host safety
Use existing secret names PROTO_HOST, PROTO_USER, PROTO_SSH_PORT, PROTO_SSH_KEY if authorized for this repo; the last **stores an SSH password**, not a private key. Verify SSH server identity. Do not expose container ports publicly, mutate other app paths, or alter existing proxy/site rules without inspecting the actual host.
