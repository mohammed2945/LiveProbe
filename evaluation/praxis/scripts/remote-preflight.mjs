#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, platform, totalmem } from "node:os";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function commandVersion(command, args) {
  try {
    const { stdout, stderr } = await execute(command, args, {
      timeout: 10_000,
    });
    return {
      available: true,
      version: `${stdout}${stderr}`.trim().split("\n")[0],
    };
  } catch (error) {
    return {
      available: false,
      error: error.code === "ENOENT" ? "not found" : error.message,
    };
  }
}

export async function inspectHost() {
  const tools = Object.fromEntries(
    await Promise.all(
      [
        ["docker", ["--version"]],
        ["kind", ["--version"]],
        ["kubectl", ["version", "--client=true"]],
        ["helm", ["version", "--short"]],
        ["python3.12", ["--version"]],
        ["go", ["version"]],
      ].map(async ([command, args]) => [
        command,
        await commandVersion(command, args),
      ]),
    ),
  );
  tools.praxis_python_dependencies = await commandVersion(
    "python3.12",
    [
      "-c",
      [
        "import importlib.util",
        "modules = [" +
          [
            "clickhouse_connect",
            "dotenv",
            "fastapi",
            "filelock",
            "kubernetes",
            "langchain_core",
            "langgraph",
            "litellm",
            "matplotlib",
            "multipart",
            "neo4j",
            "numba",
            "openai",
            "pydantic",
            "reflex",
            "requests",
            "scipy",
            "seaborn",
            "streamlit",
            "streamlit_agraph",
            "tiktoken",
            "toml",
          ]
            .map((name) => JSON.stringify(name))
            .join(", ") +
          "]",
        "missing = [name for name in modules if importlib.util.find_spec(name) is None]",
        "assert not missing, 'missing: ' + ', '.join(missing)",
      ].join("; "),
    ],
  );
  let osRelease = "";
  try {
    osRelease = await readFile("/etc/os-release", "utf8");
  } catch {
    // macOS/local fixture hosts do not expose /etc/os-release.
  }
  const facts = {
    schema_version: "praxis-remote-preflight/v1",
    platform: platform(),
    cpu_count: cpus().length,
    memory_gib: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    os_release: osRelease,
    tools,
  };
  const failures = [];
  if (facts.platform !== "linux") failures.push("platform must be linux");
  if (facts.cpu_count < 16) failures.push("at least 16 CPU cores are required");
  if (facts.memory_gib < 32) failures.push("at least 32 GiB RAM is required");
  for (const command of Object.keys(tools)) {
    if (!tools[command].available) {
      failures.push(
        command === "praxis_python_dependencies"
          ? "released PRAXIS Python dependencies are required"
          : `${command} is required`,
      );
    }
  }
  if (
    tools.helm.available &&
    !String(tools.helm.version).includes("v3.18.4")
  ) {
    failures.push("Helm must be exactly v3.18.4 for the released artifact");
  }
  return {
    ...facts,
    supported: failures.length === 0,
    failures,
  };
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  inspectHost()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.supported) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`remote-preflight: ${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
