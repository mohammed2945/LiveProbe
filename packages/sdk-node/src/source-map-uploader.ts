import { readdir, readFile } from "node:fs/promises";
import { posix, relative, resolve } from "node:path";

import { TraceMap, type SourceMapInput } from "@jridgewell/trace-mapping";

import type { BrokerClient } from "./broker-client.js";

export interface SourceMapUploaderOptions {
  broker: Pick<
    BrokerClient,
    "completeSourceMaps" | "sourceMapStatus" | "uploadSourceMap"
  >;
  serviceId: string;
  commitSha: string;
  uploaderId: string;
  sourceMapDir?: string;
  distLocation?: string;
  appRoot?: string;
  cwd?: string;
  onWarning?: (message: string) => void;
}

export type SourceMapSyncResult = "complete" | "uploaded" | "waiting";

function normalizePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+$/u, "");
}

export function stripSourcesContent(value: unknown): Record<string, unknown> {
  const stripped = JSON.parse(
    JSON.stringify(value, (key, child) =>
      key === "sourcesContent" ? undefined : child,
    ),
  ) as unknown;
  if (
    typeof stripped !== "object" ||
    stripped === null ||
    Array.isArray(stripped)
  ) {
    throw new Error("source map must be a JSON object");
  }
  return stripped as Record<string, unknown>;
}

export function remoteSourceMapPath(
  file: string,
  cwd: string,
  appRoot: string,
  distLocation: string,
): string {
  const local = normalizePath(relative(cwd, file));
  const prefix = normalizePath(posix.join(appRoot, distLocation));
  if (prefix.length === 0) return local;
  const prefixParts = prefix.split("/").filter(Boolean);
  const localParts = local.split("/").filter(Boolean);
  let overlap = 0;
  for (
    let length = Math.min(prefixParts.length, localParts.length);
    length > 0;
    length -= 1
  ) {
    if (
      prefixParts.slice(-length).join("/") ===
      localParts.slice(0, length).join("/")
    ) {
      overlap = length;
      break;
    }
  }
  return [...prefixParts, ...localParts.slice(overlap)].join("/");
}

async function findSourceMaps(directory: string, output: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
          await findSourceMaps(path, output);
        }
      } else if (entry.isFile() && entry.name.endsWith(".js.map")) {
        output.push(path);
      }
    }),
  );
}

export class SourceMapUploader {
  readonly #options: SourceMapUploaderOptions;
  readonly #cwd: string;
  readonly #sourceMapDir: string;

  public constructor(options: SourceMapUploaderOptions) {
    this.#options = options;
    this.#cwd = resolve(options.cwd ?? process.cwd());
    this.#sourceMapDir = resolve(options.sourceMapDir ?? this.#cwd);
  }

  public async sync(): Promise<SourceMapSyncResult> {
    const identity = {
      serviceId: this.#options.serviceId,
      commitSha: this.#options.commitSha,
      uploaderId: this.#options.uploaderId,
    };
    const status = await this.#options.broker.sourceMapStatus(identity);
    if (status.isComplete) return "complete";
    if (!status.isUploader) return "waiting";

    const files: string[] = [];
    try {
      await findSourceMaps(this.#sourceMapDir, files);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        files.length = 0;
      } else {
        throw error;
      }
    }
    files.sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      let map: Record<string, unknown>;
      try {
        const decoded = JSON.parse(await readFile(file, "utf8")) as unknown;
        map = stripSourcesContent(decoded);
        new TraceMap(map as unknown as SourceMapInput, file);
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        (this.#options.onWarning ?? ((message) => process.stdout.write(`${message}\n`)))(
          `[liveprobe] SOURCE MAP SKIPPED ${normalizePath(relative(this.#cwd, file))}: ${detail.replace(/[\r\n]/gu, " ")}`,
        );
        continue;
      }
      await this.#options.broker.uploadSourceMap({
        ...identity,
        mapPath: remoteSourceMapPath(
          file,
          this.#cwd,
          this.#options.appRoot ?? "",
          this.#options.distLocation ?? "dist",
        ),
        map,
      });
    }
    await this.#options.broker.completeSourceMaps(identity);
    return "uploaded";
  }
}
