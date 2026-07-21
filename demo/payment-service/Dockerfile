# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /workspace
COPY packages/sdk-node/package.json packages/sdk-node/package.json
COPY packages/sdk-node/dist packages/sdk-node/dist
RUN npm install --prefix packages/sdk-node \
    --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund
COPY demo/payment-service/package.json demo/payment-service/package-lock.json demo/payment-service/

WORKDIR /workspace/demo/payment-service
RUN npm ci

COPY demo/payment-service/tsconfig.json ./
COPY demo/payment-service/src ./src
COPY demo/payment-service/test ./test
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SERVICE_ID=payment-service \
    BROKER_URL=http://broker:7070 \
    HOST=0.0.0.0 \
    PORT=8080 \
    BUG=on

WORKDIR /workspace
COPY --from=build /workspace/packages/sdk-node ./packages/sdk-node
COPY --from=build /workspace/demo/payment-service/package.json ./demo/payment-service/package.json
COPY --from=build /workspace/demo/payment-service/node_modules ./demo/payment-service/node_modules
COPY --from=build /workspace/demo/payment-service/dist ./demo/payment-service/dist

WORKDIR /workspace/demo/payment-service
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/src/server.js"]
