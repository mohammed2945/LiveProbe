import { posix } from "node:path";

import {
  eachMapping,
  TraceMap,
  type SourceMapInput,
} from "@jridgewell/trace-mapping";

export interface StoredSourceMap {
  mapPath: string;
  map: Record<string, unknown>;
  uploadedAt: string;
}

export interface RuntimeLocation {
  runtimeLocation: string;
  runtimeLine: number;
  runtimeColumn: number;
}

interface IndexedMapping {
  source: string;
  originalColumn: number;
  generatedLine: number;
  generatedColumn: number;
}

const traceCache = new WeakMap<Record<string, unknown>, TraceMap>();
const mappingCache = new WeakMap<TraceMap, Map<number, IndexedMapping[]>>();

function cachedTrace(stored: StoredSourceMap): TraceMap {
  const cached = traceCache.get(stored.map);
  if (cached !== undefined) return cached;
  const trace = new TraceMap(
    stored.map as unknown as SourceMapInput,
    stored.mapPath,
  );
  traceCache.set(stored.map, trace);
  return trace;
}

function indexedMappings(trace: TraceMap): Map<number, IndexedMapping[]> {
  const cached = mappingCache.get(trace);
  if (cached !== undefined) return cached;
  const byLine = new Map<number, IndexedMapping[]>();
  eachMapping(trace, (mapping) => {
    if (mapping.source === null) return;
    const entries = byLine.get(mapping.originalLine) ?? [];
    entries.push({
      source: normalizePath(mapping.source),
      originalColumn: mapping.originalColumn,
      generatedLine: mapping.generatedLine,
      generatedColumn: mapping.generatedColumn,
    });
    byLine.set(mapping.originalLine, entries);
  });
  mappingCache.set(trace, byLine);
  return byLine;
}

function normalizePath(value: string): string {
  let normalized = value.trim().replaceAll("\\", "/");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Literal matching remains useful for malformed URL escapes.
  }
  return normalized
    .replace(/^[a-z]+:\/\//iu, "")
    .replace(/^(?:\.\.\/|\.\/|\/)+/u, "")
    .replace(/\/+/gu, "/");
}

function matchesSuffix(path: string, suffix: string): boolean {
  return (
    path === suffix ||
    path.endsWith(`/${suffix}`) ||
    suffix.endsWith(`/${path}`)
  );
}

function generatedFile(mapPath: string, map: TraceMap): string {
  const fallback = mapPath.endsWith(".map") ? mapPath.slice(0, -4) : mapPath;
  if (map.file === null || map.file === undefined || map.file.length === 0) {
    return normalizePath(fallback);
  }
  const file = normalizePath(map.file);
  if (file.includes("/") || posix.dirname(mapPath) === ".") {
    return normalizePath(
      posix.normalize(posix.join(posix.dirname(mapPath), file)),
    );
  }
  return normalizePath(posix.join(posix.dirname(mapPath), file));
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

export function validateSourceMap(
  mapPath: string,
  map: Record<string, unknown>,
): void {
  try {
    new TraceMap(map as unknown as SourceMapInput, mapPath);
  } catch (error) {
    throw new Error(`invalid source map ${mapPath}`, { cause: error });
  }
}

export function resolveSourceLocation(
  maps: readonly StoredSourceMap[],
  sourceFile: string,
  sourceLine: number,
  sourceColumn = 0,
): RuntimeLocation | undefined {
  const requested = normalizePath(sourceFile);
  const matches: RuntimeLocation[] = [];

  for (const stored of maps) {
    let trace: TraceMap;
    try {
      trace = cachedTrace(stored);
    } catch {
      continue;
    }
    for (const mapping of indexedMappings(trace).get(sourceLine) ?? []) {
      if (
        mapping.originalColumn >= sourceColumn &&
        matchesSuffix(mapping.source, requested)
      ) {
        matches.push({
          runtimeLocation: generatedFile(stored.mapPath, trace),
          runtimeLine: mapping.generatedLine,
          runtimeColumn: mapping.generatedColumn,
        });
      }
    }
  }

  matches.sort(
    (left, right) =>
      left.runtimeLocation.length - right.runtimeLocation.length ||
      left.runtimeLocation.localeCompare(right.runtimeLocation) ||
      left.runtimeLine - right.runtimeLine ||
      left.runtimeColumn - right.runtimeColumn,
  );
  return matches[0];
}
