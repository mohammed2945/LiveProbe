#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const scriptRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const repositoryRoot = resolve(scriptRoot, "../..");

function parseArgs(argv) {
  const result = {
    cacheDir: resolve(repositoryRoot, ".eval-cache/praxis"),
    lock: resolve(scriptRoot, "artifact.lock.json"),
    offlineArchive: undefined,
    verifyOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cache-dir") result.cacheDir = resolve(argv[++index]);
    else if (argument === "--lock") result.lock = resolve(argv[++index]);
    else if (argument === "--offline-archive") {
      result.offlineArchive = resolve(argv[++index]);
    } else if (argument === "--verify-only") result.verifyOnly = true;
    else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function help() {
  return `Usage: node fetch-artifact.mjs [options]

Download and verify the locked PRAXIS Zenodo artifact into an ignored cache.

Options:
  --cache-dir DIR       Cache root (default: .eval-cache/praxis)
  --offline-archive ZIP Verify and use an existing archive
  --verify-only         Verify the cached/offline archive without extracting
  --lock FILE           Alternate artifact lock
  -h, --help            Show this help`;
}

async function digest(path, algorithm) {
  return createHash(algorithm).update(await readFile(path)).digest("hex");
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`artifact download returned HTTP ${response.status}`);
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

export async function fetchArtifact(options) {
  const lock = JSON.parse(await readFile(options.lock, "utf8"));
  await mkdir(options.cacheDir, { recursive: true });
  const archive =
    options.offlineArchive ??
    resolve(options.cacheDir, lock.artifact.filename);
  if (options.offlineArchive === undefined && !(await exists(archive))) {
    process.stderr.write(`Downloading ${lock.artifact.url}\n`);
    await download(lock.artifact.url, archive);
  }
  const [actualSha256, actualMd5] = await Promise.all([
    digest(archive, "sha256"),
    digest(archive, "md5"),
  ]);
  if (actualSha256 !== lock.artifact.sha256) {
    throw new Error(
      `SHA-256 mismatch for ${archive}: expected ${lock.artifact.sha256}, got ${actualSha256}`,
    );
  }
  if (actualMd5 !== lock.artifact.md5) {
    throw new Error(
      `MD5 mismatch for ${archive}: expected ${lock.artifact.md5}, got ${actualMd5}`,
    );
  }
  if ((await readFile(archive)).byteLength !== lock.artifact.size_bytes) {
    throw new Error(`size mismatch for ${archive}`);
  }
  if (options.verifyOnly) {
    return { archive, sha256: actualSha256, extracted: false };
  }

  const destination = resolve(options.cacheDir, actualSha256);
  const marker = resolve(destination, ".liveprobe-artifact.json");
  if (!(await exists(marker))) {
    const temporary = resolve(
      tmpdir(),
      `liveprobe-praxis-${process.pid}-${Date.now()}`,
    );
    await mkdir(temporary, { recursive: false });
    await run("unzip", ["-q", archive, "-d", temporary]);
    const extracted = resolve(temporary, "dsn26-praxis-ae");
    if (!(await exists(resolve(extracted, "praxis-ae"))) ||
        !(await exists(resolve(extracted, "itbench-lite-ae")))) {
      throw new Error(
        `archive ${basename(archive)} did not contain the expected artifact root`,
      );
    }
    await writeFile(
      resolve(extracted, ".liveprobe-artifact.json"),
      `${JSON.stringify({
        schema_version: "liveprobe-praxis-cache/v1",
        record_id: lock.record_id,
        sha256: actualSha256,
        extracted_at: new Date().toISOString(),
      }, null, 2)}\n`,
    );
    await rename(extracted, destination);
  }
  return {
    archive,
    sha256: actualSha256,
    extracted: true,
    root: destination,
  };
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${help()}\n`);
  else {
    fetchArtifact(options)
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`fetch-artifact: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
