# syntax=docker/dockerfile:1.7
# Build on CI, NOT on the 2C2G Aliyun host.
FROM node:22-bookworm-slim AS build
ARG PNPM_VERSION=10.19.0
WORKDIR /workspace
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate
COPY . .
# The next application slice must supply pnpm-lock.yaml and the workspaces.
RUN pnpm install --frozen-lockfile
RUN pnpm -r --if-present build
RUN pnpm --filter @sanchuang-dev/benefit-api --prod deploy --legacy /bundle
RUN mkdir -p /bundle/public && cp -a apps/admin/dist/. /bundle/public/

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATABASE_FILE=/data/benefit.sqlite
WORKDIR /app
RUN groupadd --system --gid 10001 benefit \
    && useradd --system --uid 10001 --gid 10001 --no-create-home benefit \
    && mkdir -p /data && chown benefit:benefit /data
COPY --from=build --chown=10001:10001 /bundle/ /app/
USER 10001:10001
EXPOSE 3000
# apps/api build must emit dist/index.js and GET /healthz.
CMD ["node", "dist/index.js"]
