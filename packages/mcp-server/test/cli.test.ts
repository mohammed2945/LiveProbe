import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROKER_URL,
  CliUsageError,
  parseCliArgs,
} from "../src/cli.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compiledCli = join(packageRoot, "dist", "cli.js");
const toolNames = [
  "archive_environment",
  "archive_project",
  "archive_service",
  "create_environment",
  "create_project",
  "create_service_credential",
  "get_probe_data",
  "get_safety_overview",
  "list_audit_events",
  "list_environments",
  "list_probes",
  "list_projects",
  "list_registered_services",
  "list_service_credentials",
  "list_services",
  "ping_broker",
  "register_service",
  "remove_probe",
  "revoke_service_credential",
  "set_counter_probe",
  "set_log_probe",
  "set_metric_probe",
  "set_snapshot_probe",
];

describe("liveprobe-mcp CLI", () => {
  it("uses CLI, environment, and default broker URLs in precedence order", () => {
    expect(
      parseCliArgs(
        ["--broker-url", "https://cli.example"],
        "https://env.example",
      ).brokerUrl,
    ).toBe("https://cli.example");
    expect(parseCliArgs([], "https://env.example").brokerUrl).toBe(
      "https://env.example",
    );
    expect(parseCliArgs([]).brokerUrl).toBe(DEFAULT_BROKER_URL);
  });

  it("recognizes help and reports clear argument errors", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(() => parseCliArgs(["--broker-url"])).toThrow(
      new CliUsageError("--broker-url requires a URL"),
    );
    expect(() => parseCliArgs(["--unknown"])).toThrow(
      new CliUsageError("unknown option: --unknown"),
    );
    expect(() => parseCliArgs(["unexpected"])).toThrow(
      new CliUsageError("unexpected argument: unexpected"),
    );
  });

  it("prints help and exits cleanly", () => {
    const output = execFileSync(process.execPath, [compiledCli, "--help"], {
      encoding: "utf8",
      env: { ...process.env, BROKER_URL: "" },
    });
    expect(output).toContain("Usage: liveprobe-mcp [options]");
    expect(output).toContain("--broker-url <url>");
    expect(output).toContain("BROKER_URL");
    expect(output).toContain("LIVEPROBE_API_KEY");
  });

  it.each([
    [["--broker-url"], "--broker-url requires a URL"],
    [["--unknown"], "unknown option: --unknown"],
  ])("exits nonzero for invalid arguments", (args, expectedMessage) => {
    const result = spawnSync(process.execPath, [compiledCli, ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`liveprobe-mcp: ${expectedMessage}`);
    expect(result.stderr).toContain("Try 'liveprobe-mcp --help' for usage.");
  });
});

describe("published tarball", () => {
  it(
    "installs the packed CLI and lists the complete MCP tool set over stdio",
    async () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), "liveprobe-mcp-"));
      try {
        // Deliberately pnpm and not npm. This package depends on
        // @doomslayer2945/liveprobe-protocol through the workspace, and only
        // pnpm rewrites `workspace:*` to a real version when it packs. `npm
        // pack` would ship that specifier verbatim and every install of the
        // published tarball would fail on an unsupported URL type.
        const pack = (filter: string) => {
          const output = execFileSync(
            "pnpm",
            [
              "--filter",
              filter,
              "pack",
              "--json",
              "--pack-destination",
              temporaryRoot,
            ],
            { cwd: packageRoot, encoding: "utf8" },
          );
          return JSON.parse(output) as {
            filename: string;
            files: Array<{ path: string }>;
          };
        };

        const protocolResult = pack("@doomslayer2945/liveprobe-protocol");
        const packResult = pack("@doomslayer2945/liveprobe-mcp");

        const packedPaths = packResult.files.map(({ path }) => path).sort();
        expect(packedPaths).toContain("README.md");
        expect(packedPaths).toContain("dist/cli.js");
        expect(packedPaths).toContain("dist/index.js");
        expect(packedPaths).toContain("package.json");
        expect(
          packedPaths.filter(
            (path) =>
              path.startsWith("src/") ||
              path.startsWith("test/") ||
              path.includes(".env") ||
              /secret/i.test(path),
          ),
        ).toEqual([]);

        const tarballPath = resolve(temporaryRoot, packResult.filename);
        const protocolTarballPath = resolve(
          temporaryRoot,
          protocolResult.filename,
        );
        const installRoot = join(temporaryRoot, "installed");
        // The protocol tarball stands in for the registry copy. Publishing it
        // before the MCP package is a real release-ordering constraint, not a
        // test artefact: the MCP tarball declares a hard version dependency on
        // it.
        execFileSync(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefix",
            installRoot,
            protocolTarballPath,
            tarballPath,
          ],
          { encoding: "utf8" },
        );

        const installedPackageJson = JSON.parse(
          readFileSync(
            join(
              installRoot,
              "node_modules",
              "@doomslayer2945",
              "liveprobe-mcp",
              "package.json",
            ),
            "utf8",
          ),
        ) as {
          name?: string;
          version?: string;
          dependencies?: Record<string, string>;
        };
        // Compare against the source manifest rather than a literal, so a
        // version bump does not fail this test for the wrong reason. What is
        // being checked is that the packed tarball carries the version it was
        // built from, not that the version is any particular number.
        const sourceVersion = (
          JSON.parse(
            readFileSync(
              new URL("../package.json", import.meta.url),
              "utf8",
            ),
          ) as { version: string }
        ).version;
        expect(installedPackageJson).toMatchObject({
          name: "@doomslayer2945/liveprobe-mcp",
          version: sourceVersion,
        });
        // A `workspace:` specifier that survives into the published manifest
        // is uninstallable for everyone outside this repository, and the
        // failure only shows up after publishing.
        expect(
          Object.values(installedPackageJson.dependencies ?? {}),
        ).not.toContainEqual(expect.stringContaining("workspace:"));
        expect(installedPackageJson.dependencies).toMatchObject({
          "@doomslayer2945/liveprobe-protocol": "0.4.0",
        });

        const transport = new StdioClientTransport({
          command: join(installRoot, "node_modules", ".bin", "liveprobe-mcp"),
          args: ["--broker-url", "http://127.0.0.1:1"],
          stderr: "pipe",
        });
        let serverStderr = "";
        transport.stderr?.on("data", (chunk: Buffer) => {
          serverStderr += chunk.toString();
        });
        const client = new Client(
          { name: "packed-liveprobe-mcp-test", version: "1.0.0" },
          { capabilities: {} },
        );
        try {
          await client.connect(transport).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(
              `installed CLI failed to initialize: ${message}\n${serverStderr}`,
            );
          });
          const tools = await client.listTools();
          expect(tools.tools.map(({ name }) => name).sort()).toEqual(toolNames);
        } finally {
          await client.close();
        }
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
