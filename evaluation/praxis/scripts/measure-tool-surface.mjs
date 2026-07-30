// Measure the prompt cost of each LiveProbe profile's tool surface.
// tools/list needs no live broker, so this is free.
import { spawn } from "node:child_process";
const ROOT = "/Users/veer/Documents/StartUp/hackathon_stanford/LightProbe";

function measure(profile) {
  return new Promise((done) => {
    const args = profile === "none"
      ? [`${ROOT}/packages/mcp-server/dist/cli.js`, "--broker-url", "http://127.0.0.1:7070"]
      : [`${ROOT}/evaluation/praxis/src/mcp-filter-proxy.mjs`, "--profile", profile, "--",
         process.execPath, `${ROOT}/packages/mcp-server/dist/cli.js`,
         "--broker-url", "http://127.0.0.1:7070"];
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "m", version: "1" } } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 500);
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 1000);
    setTimeout(() => {
      child.kill();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2 && m.result?.tools) {
          const tools = m.result.tools;
          const bytes = JSON.stringify(tools).length;
          const descBytes = tools.reduce((n, t) => n + (t.description?.length ?? 0), 0);
          const schemaBytes = tools.reduce((n, t) => n + JSON.stringify(t.inputSchema ?? {}).length, 0);
          done({ profile, count: tools.length, bytes, descBytes, schemaBytes,
                 names: tools.map((t) => t.name) });
          return;
        }
      }
      done({ profile, error: "no tools/list response" });
    }, 3500);
  });
}

for (const p of ["raw", "graph"]) {
  const r = await measure(p);
  if (r.error) { console.log(p, r.error); continue; }
  console.log(`${r.profile.padEnd(6)} tools=${String(r.count).padStart(2)} `
    + `total=${String(r.bytes).padStart(6)}B desc=${String(r.descBytes).padStart(5)}B `
    + `schema=${String(r.schemaBytes).padStart(6)}B  ~${Math.round(r.bytes / 4)} tokens`);
  if (r.profile === "graph") {
    const legacy = r.names.filter((n) => ["analyze_probe_candidates","deploy_probe_frontier","refine_probe_candidates"].includes(n));
    console.log(`       legacy tools still exposed: ${legacy.join(", ") || "none"}`);
  }
}
