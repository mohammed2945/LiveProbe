# LiveProbe payment-service demo

This deterministic Express service models a five-connection database pool. With
`BUG=on`, each free-tier payment occupies all five slots before `getBalance`.
The lookup returns `null`; `payments.ts` intentionally treats that value as a
zero balance and returns `InsufficientFunds`. Premium and enterprise traffic
continues to succeed.

The process starts the compiled `@doomslayer2945/liveprobe-node` package with `SERVICE_ID`
and `BROKER_URL` before opening its HTTP listener.

## Run locally

```sh
npm ci
npm run build
SERVICE_ID=payment-service BROKER_URL=http://127.0.0.1:7070 BUG=on npm start
```

In another shell:

```sh
TARGET_URL=http://127.0.0.1:8080 npm run traffic
```

Endpoints:

- `GET /health` reports readiness and bug mode.
- `POST /pay` accepts
  `{"user":{"id":"u-1","tier":"free"},"amountCents":2500}`.
- `GET /stats` reports request/outcome counters and pool occupancy.

`src/payments.ts` contains one `LIVEPROBE_SNAPSHOT_TARGET` marker. The build
preserves it in `dist/src/payments.js`; the e2e test derives the exact compiled
line from that marker so probes remain stable as surrounding code changes.

## Verify

```sh
npm test
npm run e2e
```

The e2e test starts the compiled broker, this service, and mixed-tier traffic.
It creates a broker snapshot probe conditioned on `user.tier eq free`, then
asserts within 15 seconds that the sanitized tree contains `balance: null` and
`pool.active: 5`. It also checks the `/stats` request counter before, during,
and after the probe hit.

Build the container from the repository root:

```sh
docker build -f demo/payment-service/Dockerfile -t liveprobe-payment-demo .
```
