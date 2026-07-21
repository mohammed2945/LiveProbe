# @doomslayer2945/liveprobe-node

Node.js runtime agent for LiveProbe.

```ts
import { LiveProbe } from "@doomslayer2945/liveprobe-node";

const agent = await LiveProbe.start({
  serviceId: "payments",
  brokerUrl: process.env.BROKER_URL ?? "http://127.0.0.1:7070",
  apiKey: process.env.LIVEPROBE_API_KEY,
  commitSha: process.env.LIVEPROBE_COMMIT_SHA ?? process.env.GIT_COMMIT,
  sourceMapDir: process.env.LIVEPROBE_SOURCE_MAP_DIR,
  distLocation: process.env.LIVEPROBE_DIST_LOCATION,
  appRoot: process.env.LIVEPROBE_APP_ROOT,
});
```

`commitSha` is required and must be a 7-64 character hexadecimal Git object ID.
`apiKey` is sent as `Authorization: Bearer <key>`.

For TypeScript, Esbuild, or Webpack builds, emit external `.js.map` files. One
agent instance uploads maps for each service/commit pair, with embedded
`sourcesContent` removed. The broker performs source-to-generated line and
column translation and returns runtime coordinates to every Node agent.

- `sourceMapDir` / `LIVEPROBE_SOURCE_MAP_DIR`: scan root for `.js.map` files;
  defaults to `process.cwd()`.
- `distLocation` / `LIVEPROBE_DIST_LOCATION`: generated output prefix; defaults
  to `dist`.
- `appRoot` / `LIVEPROBE_APP_ROOT`: optional monorepo subdirectory prefix.
