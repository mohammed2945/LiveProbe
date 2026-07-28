import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(root, "spec", "fixtures", "serializer");
const expressionFixturePath = join(
  root,
  "spec",
  "fixtures",
  "expressions",
  "evaluator.json",
);
const requiredFixtures = new Set([
  "circular.json",
  "deep-object.json",
  "long-array.json",
  "mixed-kitchen-sink.json",
  "nested-secrets.json",
  "redact-values.json",
]);
const nodeTypes = new Set([
  "str",
  "num",
  "bool",
  "null",
  "obj",
  "arr",
  "fn",
  "truncated",
  "redacted",
  "unavailable",
]);
const truncationReasons = new Set([
  "depth",
  "array",
  "props",
  "string",
  "circular",
  "unsupported",
]);

function fail(location, message) {
  throw new Error(`${location}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMarker(marker, location, expectedReason) {
  validateNode(marker, location);
  if (marker.t !== "truncated" || marker.v !== expectedReason) {
    fail(location, `must be a ${expectedReason} truncation marker`);
  }
}

function validateNode(node, location) {
  if (!isObject(node) || !nodeTypes.has(node.t)) {
    fail(location, "must be a serialized tree node");
  }

  switch (node.t) {
    case "str":
      if (typeof node.v !== "string") fail(location, "str.v must be a string");
      break;
    case "num":
      if (typeof node.v !== "number" || !Number.isFinite(node.v)) {
        fail(location, "num.v must be a finite number");
      }
      break;
    case "bool":
      if (typeof node.v !== "boolean") fail(location, "bool.v must be boolean");
      break;
    case "null":
      if (node.v !== null) fail(location, "null.v must be null");
      break;
    case "obj":
      if (!isObject(node.c)) fail(location, "obj.c must be an object");
      for (const [key, child] of Object.entries(node.c)) {
        validateNode(child, `${location}.c[${JSON.stringify(key)}]`);
      }
      if (node.m !== undefined) validateMarker(node.m, `${location}.m`, "props");
      break;
    case "arr":
      if (!Array.isArray(node.c)) fail(location, "arr.c must be an array");
      node.c.forEach((child, index) => validateNode(child, `${location}.c[${index}]`));
      if (node.m !== undefined) validateMarker(node.m, `${location}.m`, "array");
      break;
    case "truncated":
      if (!truncationReasons.has(node.v)) {
        fail(location, "truncated.v has an unknown reason");
      }
      break;
    case "unavailable":
      if (!isObject(node.v) || typeof node.v.reasonCode !== "string") {
        fail(location, "unavailable.v must contain a reasonCode");
      }
      break;
    case "fn":
    case "redacted":
      break;
    default:
      fail(location, "has an unreachable node type");
  }
}

function validateFixtureInput(value, location, references) {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      validateFixtureInput(child, `${location}[${index}]`, references),
    );
    return;
  }
  if (!isObject(value)) return;

  if (typeof value.$fixture === "string") {
    const tag = value.$fixture;
    if (tag === "function") {
      if (value.name !== undefined && typeof value.name !== "string") {
        fail(location, "function fixture name must be a string");
      }
      return;
    }
    if (tag === "ref") {
      if (typeof value.id !== "string" || !references.has(value.id)) {
        fail(location, "fixture ref must target a registered container");
      }
      return;
    }
    if (tag === "object" || tag === "array") {
      if (typeof value.id !== "string" || value.id.length === 0) {
        fail(location, "fixture container id must be a non-empty string");
      }
      if (references.has(value.id)) {
        fail(location, `duplicate fixture id ${JSON.stringify(value.id)}`);
      }
      if (tag === "object" && !isObject(value.value)) {
        fail(location, "object fixture value must be an object");
      }
      if (tag === "array" && !Array.isArray(value.value)) {
        fail(location, "array fixture value must be an array");
      }
      references.add(value.id);
      validateFixtureInput(value.value, `${location}.value`, references);
      return;
    }
    fail(location, `unknown fixture tag ${JSON.stringify(tag)}`);
  }

  for (const [key, child] of Object.entries(value)) {
    validateFixtureInput(child, `${location}[${JSON.stringify(key)}]`, references);
  }
}

const files = (await readdir(fixtureDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();

for (const required of requiredFixtures) {
  if (!files.includes(required)) fail(fixtureDirectory, `missing ${required}`);
}

for (const file of files) {
  const path = join(fixtureDirectory, file);
  let fixture;
  try {
    fixture = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(file, `invalid JSON (${error instanceof Error ? error.message : error})`);
  }

  if (!isObject(fixture)) fail(file, "fixture must be an object");
  const keys = Object.keys(fixture).sort();
  if (keys.join(",") !== "config,expected,input") {
    fail(file, "top-level fields must be exactly input, config, and expected");
  }
  if (!isObject(fixture.config)) fail(`${file}.config`, "must be an object");

  validateFixtureInput(fixture.input, `${file}.input`, new Set());
  validateNode(fixture.expected, `${file}.expected`);
}

const expressionFixture = JSON.parse(
  await readFile(expressionFixturePath, "utf8"),
);
if (
  !isObject(expressionFixture) ||
  !Array.isArray(expressionFixture.cases) ||
  expressionFixture.cases.length === 0
) {
  fail(expressionFixturePath, "must contain a non-empty cases array");
}
for (const [index, testCase] of expressionFixture.cases.entries()) {
  const location = `evaluator.json.cases[${index}]`;
  if (!isObject(testCase)) fail(location, "must be an object");
  if (typeof testCase.name !== "string" || testCase.name.length === 0) {
    fail(`${location}.name`, "must be a non-empty string");
  }
  if (!isObject(testCase.expression) || !isObject(testCase.expression.ast)) {
    fail(`${location}.expression`, "must contain source and ast");
  }
  if (typeof testCase.expression.source !== "string") {
    fail(`${location}.expression.source`, "must be a string");
  }
  if (!isObject(testCase.expected) || typeof testCase.expected.ok !== "boolean") {
    fail(`${location}.expected`, "must contain a boolean ok field");
  }
}

console.log(
  `Validated ${files.length} serializer fixtures and ${expressionFixture.cases.length} expression cases.`,
);
