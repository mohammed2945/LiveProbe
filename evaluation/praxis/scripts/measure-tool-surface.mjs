// Measure the prompt cost of each LiveProbe profile's tool surface.
//
// A tool surface is fixed prefix: its name, description and input schema are
// re-sent on every model turn for the whole run, so a token here is paid tens
// of times per incident. `tools/list` needs no live broker, so measuring it is
// free.
//
// Cost is reported in `o200k_base` tokens, not bytes. Bytes were the unit in
// the first version of this script and a bytes/4 estimate understates JSON
// schema text, which tokenises closer to 3.4 bytes/token — the error is large
// enough to change which tool looks expensive.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { encode } from "gpt-tokenizer/encoding/o200k_base";

// Resolve from this file, not from a hard-coded absolute path, so the script
// measures the checkout it lives in (including a worktree).
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SERVER = `${ROOT}packages/mcp-server/dist/cli.js`;
const PROXY = `${ROOT}evaluation/praxis/src/mcp-filter-proxy.mjs`;

const tokens = (value) => (value === undefined ? 0 : encode(value).length);

function measure(profile) {
  return new Promise((done) => {
    const args =
      profile === "none"
        ? [SERVER, "--broker-url", "http://127.0.0.1:7070"]
        : [
            PROXY,
            "--profile",
            profile,
            "--",
            process.execPath,
            SERVER,
            "--broker-url",
            "http://127.0.0.1:7070",
          ];
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "m", version: "1" },
      },
    });
    setTimeout(
      () => send({ jsonrpc: "2.0", method: "notifications/initialized" }),
      500,
    );
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list" }), 1000);
    setTimeout(() => {
      child.kill();
      let instructions = "";
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1 && typeof m.result?.instructions === "string") {
          instructions = m.result.instructions;
        }
        if (m.id === 2 && m.result?.tools) {
          const tools = m.result.tools.map((tool) => {
            const schema = JSON.stringify(tool.inputSchema ?? {});
            const whole = tokens(JSON.stringify(tool));
            const name = tokens(tool.name);
            const description = tokens(tool.description);
            const inputSchema = tokens(schema);
            return {
              name: tool.name,
              tokens: whole,
              nameTokens: name,
              descriptionTokens: description,
              schemaTokens: inputSchema,
              // JSON punctuation, keys and the `title`/`annotations` fields.
              framingTokens: whole - name - description - inputSchema,
              bytes: Buffer.byteLength(JSON.stringify(tool)),
            };
          });
          done({
            profile,
            tools,
            // The whole array as one string: what a client is actually handed.
            surfaceTokens: tokens(JSON.stringify(m.result.tools)),
            surfaceBytes: Buffer.byteLength(JSON.stringify(m.result.tools)),
            // Server-level prose is sent once per session, not per turn.
            instructionTokens: tokens(instructions),
          });
          return;
        }
      }
      done({ profile, error: "no tools/list response" });
    }, 3500);
  });
}

const pad = (value, width) => String(value).padStart(width);

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const profiles = requested.length > 0 ? requested : ["raw", "graph"];
const asJson = process.argv.includes("--json");
const report = {};

for (const profile of profiles) {
  const result = await measure(profile);
  if (result.error) {
    console.error(`${profile}: ${result.error}`);
    process.exitCode = 1;
    continue;
  }
  report[profile] = result;
  if (asJson) continue;

  const ordered = [...result.tools].sort((a, b) => b.tokens - a.tokens);
  console.log(`\n=== profile ${result.profile} — ${result.tools.length} tools ===`);
  console.log(
    `${"tool".padEnd(34)}${pad("total", 7)}${pad("name", 7)}${pad("desc", 7)}` +
      `${pad("schema", 8)}${pad("frame", 7)}${pad("bytes", 8)}`,
  );
  for (const tool of ordered) {
    console.log(
      `${tool.name.padEnd(34)}${pad(tool.tokens, 7)}${pad(tool.nameTokens, 7)}` +
        `${pad(tool.descriptionTokens, 7)}${pad(tool.schemaTokens, 8)}` +
        `${pad(tool.framingTokens, 7)}${pad(tool.bytes, 8)}`,
    );
  }
  const sum = (key) => ordered.reduce((n, tool) => n + tool[key], 0);
  console.log(
    `${"TOTAL".padEnd(34)}${pad(sum("tokens"), 7)}${pad(sum("nameTokens"), 7)}` +
      `${pad(sum("descriptionTokens"), 7)}${pad(sum("schemaTokens"), 8)}` +
      `${pad(sum("framingTokens"), 7)}${pad(sum("bytes"), 8)}`,
  );
  console.log(
    `surface as one array: ${result.surfaceTokens} tokens / ` +
      `${result.surfaceBytes} bytes ` +
      `(${(result.surfaceBytes / result.surfaceTokens).toFixed(2)} bytes/token)`,
  );
  console.log(
    `server instructions (sent once per session, not per turn): ` +
      `${result.instructionTokens} tokens`,
  );
}

if (asJson) console.log(JSON.stringify(report, null, 2));
