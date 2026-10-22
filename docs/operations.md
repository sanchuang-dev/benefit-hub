# Benefit Hub — operations and deployment contract

## Server preflight (not yet executed)
1. Inspect the company's **new** Aliyun instance, Docker Engine / Docker Compose v2 status, RAM, disk, network and running services. Do not touch the company's unrelated primary server.
2. Confirm loopback port 18080 is unused; otherwise choose an available loopback port and update the environment variable.
3. Create a dedicated persistent /srv/benefit-hub/data directory owned by UID/GID 10001 with restrictive mode. Ensure backups are in place.
4. Verify SSH host identity, then use the existing repository/organization secret **names** PROTO_HOST, PROTO_USER, PROTO_SSH_PORT, PROTO_SSH_KEY (last one is a **password**). Do not claim these values are verified or expose them in logs.
5. Add a validated explicit Caddy route for a selected hostname. Keep all existing prototype hosts working.

## Build and release
The repository starts with the Docker contract only; do not deploy until the Hono and admin workspace code + pnpm lockfile exist and the exact commit builds successfully.

- PR from feat/* to dev: checks only; no deployment.
- Merged dev: build a versioned image on GitHub Actions (not on 2C2G host), then transfer to the isolated benefit-hub stack after preflight; exact delivery pipeline to be added in its own verified slice.
- The container serves 127.0.0.1:18080 on the host by default. Caddy reverse proxies from HTTPS.
- After a release: verify docker container health, GET /healthz locally, the real HTTPS entrypoint externally, and logs for sensitive data.
- Keep previous image tag for rollback. Image rollback never automatically rolls back DB migrations.
- Back up SQLite using a consistent SQLite-native method (backup API or VACUUM INTO), not raw copying of a live WAL file.

Never embed app credentials in an image, mount the Docker socket in the app, blindly overwrite /etc/caddy/Caddyfile, or delete the persistent database directory.
