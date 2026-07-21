#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startStdioServer } from "./index.js";

export const DEFAULT_BROKER_URL = "http://127.0.0.1:7070";

export interface CliOptions {
  brokerUrl: string;
  help: boolean;
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(
  args: readonly string[],
  envBrokerUrl?: string,
): CliOptions {
  let brokerUrl: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--broker-url") {
      if (brokerUrl !== undefined) {
        throw new CliUsageError("--broker-url may only be specified once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError("--broker-url requires a URL");
      }
      brokerUrl = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("-") === true) {
      throw new CliUsageError(`unknown option: ${argument}`);
    }
    throw new CliUsageError(`unexpected argument: ${argument ?? ""}`);
  }

  return {
    brokerUrl: brokerUrl ?? envBrokerUrl ?? DEFAULT_BROKER_URL,
    help,
  };
}

export function formatHelp(): string {
  return `Usage: liveprobe-mcp [options]

Run the LiveProbe MCP server over stdio.

Options:
  --broker-url <url>  LiveProbe broker URL
  -h, --help          Show this help

Environment:
  BROKER_URL          Broker URL fallback
  LIVEPROBE_API_KEY   Bearer key shared with the broker

Default broker URL: ${DEFAULT_BROKER_URL}`;
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  envBrokerUrl: string | undefined = process.env["BROKER_URL"],
): Promise<number> {
  const options = parseCliArgs(args, envBrokerUrl);
  if (options.help) {
    process.stdout.write(`${formatHelp()}\n`);
    return 0;
  }

  await startStdioServer(options.brokerUrl);
  return 0;
}

const executedPath = process.argv[1];
if (
  executedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) ===
    realpathSync(resolve(executedPath))
) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`liveprobe-mcp: ${message}`);
    if (error instanceof CliUsageError) {
      console.error("Try 'liveprobe-mcp --help' for usage.");
    }
    process.exitCode = 1;
  });
}
