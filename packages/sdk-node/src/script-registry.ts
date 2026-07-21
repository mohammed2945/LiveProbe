import { fileURLToPath } from "node:url";

import type { ScriptParsedEvent } from "./types.js";

export interface RegisteredScript {
  scriptId: string;
  url: string;
  path: string;
}

export type ScriptResolution =
  | { status: "found"; script: RegisteredScript }
  | { status: "missing" }
  | { status: "ambiguous"; matches: RegisteredScript[] };

export function normalizeScriptPath(value: string): string {
  let normalized = value.trim();
  if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Keep the original URL and still apply suffix matching below.
    }
  } else {
    const queryIndex = normalized.search(/[?#]/u);
    if (queryIndex >= 0) {
      normalized = normalized.slice(0, queryIndex);
    }
    try {
      normalized = decodeURIComponent(normalized);
    } catch {
      // Invalid escapes are harmless for literal suffix matching.
    }
  }
  return normalized.replaceAll("\\", "/").replace(/\/+/gu, "/");
}

function normalizedProbeSuffix(file: string): string {
  return normalizeScriptPath(file).replace(/^(?:\.\.\/|\.\/|\/)+/u, "");
}

function matchesSuffix(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(`/${suffix}`);
}

export class ScriptRegistry {
  readonly #scripts = new Map<string, RegisteredScript>();

  register(event: ScriptParsedEvent): RegisteredScript | undefined {
    if (
      typeof event.scriptId !== "string" ||
      event.scriptId.length === 0 ||
      typeof event.url !== "string" ||
      event.url.length === 0
    ) {
      return undefined;
    }
    const script = {
      scriptId: event.scriptId,
      url: event.url,
      path: normalizeScriptPath(event.url),
    };
    this.#scripts.set(script.scriptId, script);
    return script;
  }

  findBySuffix(file: string): RegisteredScript | undefined {
    const resolution = this.resolveBySuffix(file);
    return resolution.status === "found" ? resolution.script : undefined;
  }

  resolveBySuffix(file: string): ScriptResolution {
    const suffix = normalizedProbeSuffix(file);
    if (suffix.length === 0) {
      return { status: "missing" };
    }
    const matches = [...this.#scripts.values()].filter((script) =>
      matchesSuffix(script.path, suffix),
    );
    return this.#resolutionFromMatches(matches);
  }

  #resolutionFromMatches(matches: RegisteredScript[]): ScriptResolution {
    if (matches.length === 0) {
      return { status: "missing" };
    }
    matches.sort(
      (left, right) =>
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path) ||
        left.scriptId.localeCompare(right.scriptId),
    );
    const best = matches[0];
    if (best === undefined) {
      return { status: "missing" };
    }
    const equallySpecific = matches.filter(
      (candidate) => candidate.path.length === best.path.length,
    );
    if (equallySpecific.length > 1) {
      return { status: "ambiguous", matches: equallySpecific };
    }
    return { status: "found", script: best };
  }

  get(scriptId: string): RegisteredScript | undefined {
    return this.#scripts.get(scriptId);
  }

  clear(): void {
    this.#scripts.clear();
  }
}
