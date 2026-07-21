import { FakeAgent } from "../src/fake-agent.js";

const sdk = process.env["SDK"];
if (sdk !== undefined && sdk !== "node" && sdk !== "python" && sdk !== "jvm") {
  throw new Error("SDK must be node, python, or jvm");
}

const pollInterval = Number(process.env["POLL_INTERVAL_MS"] ?? "1000");
if (!Number.isInteger(pollInterval) || pollInterval <= 0) {
  throw new Error("POLL_INTERVAL_MS must be a positive integer");
}

const agent = new FakeAgent({
  brokerUrl: process.env["BROKER_URL"] ?? "http://127.0.0.1:7070",
  serviceId: process.env["SERVICE_ID"] ?? "fake-service",
  commitSha:
    process.env["LIVEPROBE_COMMIT_SHA"] ??
    process.env["GIT_COMMIT"] ??
    "abcdef1234567890",
  ...(process.env["LIVEPROBE_API_KEY"] === undefined
    ? {}
    : { apiKey: process.env["LIVEPROBE_API_KEY"] }),
  pollIntervalMs: pollInterval,
  ...(sdk === undefined ? {} : { sdk }),
});

const abortController = new AbortController();
process.once("SIGINT", () => {
  abortController.abort();
});
process.once("SIGTERM", () => {
  abortController.abort();
});

console.error(
  `[liveprobe] fake agent polling as ${process.env["SERVICE_ID"] ?? "fake-service"}`,
);
agent.run(abortController.signal).catch((error: unknown) => {
  console.error("[liveprobe] fake agent failed", error);
  process.exitCode = 1;
});
