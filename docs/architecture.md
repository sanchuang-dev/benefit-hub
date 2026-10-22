# Benefit Hub — architecture (2026-10-22)

Technical architecture is maintained here. **Root `design.md` is reserved for visual and interaction design.**

## Phase one
- Internal benefit API + a provider adapter for Yangmao A/B/C/D + light operator console.
- Selected: TypeScript strict, Node 22, Hono, Zod, SQLite/Drizzle, React/Vite/Ant Design 6, React Router, TanStack Query, Zustand, pnpm workspaces.
- Runtime: ONE Node container serves Hono API and built React static assets. The existing **host Caddy** provides TLS and reverse proxy. No database or reverse-proxy container.
- SQLite is sufficient for first-release single app instance. DB access stays behind repositories for future migration; switching dialect and copying real production data still requires a reviewed migration.
- Strong idempotency, explicit fulfillment states, persistent audit and server-side credentials are required before real external issuance.

## Docker design
`Dockerfile` uses Debian-based Node 22 to avoid Alpine / native SQLite driver ABI friction. It compiles both apps in a builder stage, uses pnpm deploy to copy only API production dependencies, includes the admin build in /app/public, and runs as unprivileged UID/GID 10001.

`compose.yaml` binds the HTTP port to host loopback only (default proposed 18080, must inspect before assignment). Database storage is mounted at /data from the host path (default /srv/benefit-hub/data). Upgrade and rollback must retain that directory.

## NOT implemented yet
This slice provides the Docker **contract only**. `apps/api`, `apps/admin`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, and `GET /healthz` must be implemented in the next slice. **This Dockerfile cannot build successfully until then.**

No Docker availability / host port / disk / DNS / Caddy / real HTTPS has been checked on the purchased server. Never interpret the presence of a Dockerfile as a deployed service.
