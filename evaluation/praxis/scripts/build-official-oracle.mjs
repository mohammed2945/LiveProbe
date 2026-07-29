#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";

const evaluationRoot = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const result = {
    artifactRoot: undefined,
    output: undefined,
    incidents: undefined,
  };
  for (const argument of argv) {
    if (argument.startsWith("--artifact-root=")) {
      result.artifactRoot = resolve(argument.slice(16));
    } else if (argument.startsWith("--output=")) {
      result.output = resolve(argument.slice(9));
    } else if (argument.startsWith("--incidents=")) {
      result.incidents = argument.slice(12).split(",").filter(Boolean);
    } else if (argument === "--help" || argument === "-h") result.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return result;
}

function help() {
  return `Usage: node build-official-oracle.mjs --artifact-root=DIR --output=FILE [--incidents=401,402]

The output is scorer-only. Never mount it into an agent working directory or
include it in an evidence snapshot, prompt, or MCP response.`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanFilterAlias(pattern) {
  const cleaned = String(pattern)
    .replaceAll("\\b", "")
    .replaceAll("\\.", ".")
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/-\.\*$/, "")
    .replace(/\.\*$/, "");
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(cleaned)
    ? cleaned
    : undefined;
}

function idAlias(id) {
  return String(id).replace(
    /-(?:service|pod|config|configmap|deployment|endpoint|operation|networkchaos|stresschaos)-\d+$/i,
    "",
  );
}

function groupAliases(group) {
  return [
    group.id,
    idAlias(group.id),
    ...(group.filter ?? []).map(cleanFilterAlias).filter(Boolean),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function mergeAliasGroups(groups) {
  const pending = groups
    .map((group) => [...new Set(group)])
    .filter((group) => group.length > 0);
  const result = [];
  while (pending.length > 0) {
    const merged = new Set(pending.shift());
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index].some((value) => merged.has(value))) {
        for (const value of pending[index]) merged.add(value);
        pending.splice(index, 1);
      }
    }
    result.push([...merged]);
  }
  return result;
}

function expectedStatuses(scenario) {
  switch (scenario.expected_liveprobe_terminal) {
    case "LOCALIZED":
      return ["LOCALIZED"];
    case "HANDOFF":
      // The common leaderboard must not penalize either an honest LiveProbe
      // boundary handback or an arm that can directly localize the external
      // resource. Root, propagation, and evidence requirements still apply.
      return ["HANDOFF", "LOCALIZED"];
    case "HANDOFF_OR_NOT_STARTED":
      return ["HANDOFF", "INSUFFICIENT", "LOCALIZED"];
    default:
      throw new Error(
        `incident ${scenario.id} has unsupported expected terminal ` +
          `${scenario.expected_liveprobe_terminal}`,
      );
  }
}

function buildIncidentOracle(groundTruth, scenario) {
  const groups = groundTruth.groups ?? [];
  const byId = new Map(groups.map((group) => [group.id, group]));
  const entityAliasGroups = mergeAliasGroups([
    ...(groundTruth.aliases ?? []),
    ...groups.map(groupAliases),
  ]);
  const roots = groups.filter((group) => group.root_cause === true);
  if (roots.length === 0) {
    throw new Error(`incident ${groundTruth.id} has no official root cause`);
  }
  const acceptedRoots = roots.map((group) => {
    const aliases =
      entityAliasGroups.find((values) => values.includes(group.id)) ??
      groupAliases(group);
    return {
      entity: idAlias(group.id),
      aliases: aliases.filter((value) => value !== idAlias(group.id)),
      kind: group.kind,
      kinds: [group.kind],
      namespace: group.namespace ?? null,
    };
  });
  const propagation = (groundTruth.propagations ?? []).map((edge) => ({
    from: idAlias(byId.get(edge.source)?.id ?? edge.source),
    to: idAlias(byId.get(edge.target)?.id ?? edge.target),
  }));
  return {
    entity: acceptedRoots[0].entity,
    aliases: acceptedRoots[0].aliases,
    kind: acceptedRoots[0].kind,
    kinds: acceptedRoots[0].kinds,
    accepted_roots: acceptedRoots,
    entity_alias_groups: entityAliasGroups,
    propagation,
    expected_statuses: expectedStatuses(scenario),
    allow_empty_evidence: false,
  };
}

export async function buildOfficialOracle(options) {
  if (options.artifactRoot === undefined || options.output === undefined) {
    throw new Error("--artifact-root and --output are required");
  }
  const scenariosPath = resolve(evaluationRoot, "scenarios.json");
  const scenariosRaw = await readFile(scenariosPath, "utf8");
  const scenarios = JSON.parse(scenariosRaw);
  const groundTruthPath = resolve(
    options.artifactRoot,
    scenarios.source.ground_truth_path,
  );
  const groundTruthRaw = await readFile(groundTruthPath, "utf8");
  const groundTruth = JSON.parse(groundTruthRaw);
  if (!Array.isArray(groundTruth)) {
    throw new Error("released ground truth must be an array");
  }
  const available = new Map(
    groundTruth.map((incident) => [String(incident.id), incident]),
  );
  const scenarioById = new Map(
    scenarios.incidents.map((incident) => [String(incident.id), incident]),
  );
  const selected =
    options.incidents ??
    scenarios.incidents
      .filter((incident) => incident.four_arm)
      .map((incident) => String(incident.id));
  const incidents = {};
  for (const incidentId of selected) {
    const incident = available.get(String(incidentId));
    if (incident === undefined) {
      throw new Error(`released ground truth has no incident ${incidentId}`);
    }
    const scenario = scenarioById.get(String(incidentId));
    if (scenario === undefined) {
      throw new Error(`scenario manifest has no incident ${incidentId}`);
    }
    incidents[String(incidentId)] = buildIncidentOracle(incident, scenario);
  }
  const output = {
    schema_version: "praxis-official-scorer-oracle/v2",
    scorer_only: true,
    provenance: {
      artifact_record: scenarios.source.artifact_record,
      ground_truth_relative_path: scenarios.source.ground_truth_path,
      ground_truth_sha256: sha256(groundTruthRaw),
      scenarios_sha256: sha256(scenariosRaw),
    },
    incidents,
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    schema_version: output.schema_version,
    output: options.output,
    incidents: Object.keys(incidents),
    ground_truth_sha256: output.provenance.ground_truth_sha256,
  };
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(`${help()}\n`);
  else {
    buildOfficialOracle(options)
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`build-official-oracle: ${error.stack ?? error}\n`);
        process.exitCode = 1;
      });
  }
}
