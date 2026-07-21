# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/broker/package.json packages/broker/
RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate \
    && pnpm install --frozen-lockfile --filter @liveprobe/broker...

COPY packages/broker/tsconfig.json packages/broker/
COPY packages/broker/src packages/broker/src
COPY packages/broker/scripts packages/broker/scripts
RUN pnpm --filter @liveprobe/broker run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7070 \
    LIVEPROBE_STATE_FILE=/var/lib/liveprobe/broker-state.json

WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/broker/package.json packages/broker/
RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate \
    && pnpm install --frozen-lockfile --prod --filter @liveprobe/broker...
COPY --from=build /workspace/packages/broker/dist packages/broker/dist

RUN mkdir -p /var/lib/liveprobe && chown -R node:node /var/lib/liveprobe
USER node
WORKDIR /workspace/packages/broker
EXPOSE 7070
VOLUME ["/var/lib/liveprobe"]
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:7070/healthz').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "dist/src/index.js"]
