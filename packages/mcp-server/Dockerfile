# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp-server/package.json packages/mcp-server/
RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate \
    && pnpm install --frozen-lockfile --filter @doomslayer2945/liveprobe-mcp...

COPY packages/mcp-server/tsconfig.json packages/mcp-server/
COPY packages/mcp-server/src packages/mcp-server/src
RUN pnpm --filter @doomslayer2945/liveprobe-mcp run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    BROKER_URL=http://broker:7070

WORKDIR /workspace
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/mcp-server/package.json packages/mcp-server/
RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate \
    && pnpm install --frozen-lockfile --prod --filter @doomslayer2945/liveprobe-mcp...
COPY --from=build /workspace/packages/mcp-server/dist packages/mcp-server/dist

USER node
WORKDIR /workspace/packages/mcp-server
ENTRYPOINT ["node", "dist/cli.js"]
