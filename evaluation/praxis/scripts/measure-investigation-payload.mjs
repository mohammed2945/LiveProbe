// Measure the response payload of the two investigation tools that dominate
// LiveProbe's non-cached token cost: `start_probe_investigation` and
// `collect_investigation_evidence`.
//
// Tool responses are never prompt-cacheable, so every byte a tool returns is
// charged as fresh input on the turn that reads it and on every later turn that
// keeps it in context. This script drives the real Python analyzer over a
// synthetic but structurally ordinary multi-service Python repository, then
// reports bytes per top-level field of the investigation view, so the compact
// projection is chosen from measurements rather than intuition.
//
// The fixture is deliberately generic: a request handler, a config reader, and
// an HTTP client. It carries no incident-specific content.
//
// Usage: node evaluation/praxis/scripts/measure-investigation-payload.mjs

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const analyzerSrc = join(repoRoot, "python/analyzer/src");
const python = process.env["LIVEPROBE_ANALYZER_PYTHON"] ?? "python3.12";

const FILES = {
  "services/__init__.py": "",
  "services/catalog/__init__.py": "",
  "services/recommend/__init__.py": "",
  "services/recommend/app.py": `import logging
import random

from services.catalog.client import ProductCatalogClient
from services.recommend.config import RecommendationConfig

logger = logging.getLogger(__name__)


class RecommendationHandler:
    def __init__(self, catalog, config):
        self.catalog = catalog
        self.config = config
        self.cache = {}

    def list_recommendations(self, request, context):
        session_id = request.session_id
        product_ids = list(request.product_ids)
        max_results = self.config.max_results
        catalog_products = self.get_product_list(product_ids)
        ranked = self.rank_products(catalog_products, session_id)
        selected = ranked[:max_results]
        response_ids = [product.identifier for product in selected]
        logger.info("returning %d recommendations", len(response_ids))
        return response_ids

    def get_product_list(self, request_product_ids):
        max_responses = self.config.max_responses
        cached = self.cache.get("catalog")
        if cached is not None and self.config.cache_enabled:
            products = cached
        else:
            products = self.catalog.list_products()
            self.cache["catalog"] = products
        filtered = self.filter_products(products, request_product_ids)
        if len(filtered) > max_responses:
            filtered = filtered[:max_responses]
        return filtered

    def filter_products(self, products, request_product_ids):
        excluded = set(request_product_ids)
        result = []
        for product in products:
            if product.identifier in excluded:
                continue
            if not self.is_visible(product):
                continue
            result.append(product)
        return result

    def is_visible(self, product):
        threshold = self.config.visibility_threshold
        score = product.popularity_score
        return score >= threshold

    def rank_products(self, products, session_id):
        seed = self.session_seed(session_id)
        weights = [self.weight_for(product, seed) for product in products]
        ordered = sorted(
            zip(products, weights), key=lambda pair: pair[1], reverse=True
        )
        return [product for product, _ in ordered]

    def session_seed(self, session_id):
        digest = 0
        for character in session_id:
            digest = (digest * 31 + ord(character)) % 1000003
        return digest

    def weight_for(self, product, seed):
        base = product.popularity_score
        jitter = random.Random(seed + product.id_hash).random()
        boost = self.config.boost_factor
        return base * boost + jitter
`,
  "services/recommend/config.py": `import os


class RecommendationConfig:
    def __init__(self, environment):
        self.environment = environment
        self.max_results = self.read_int("MAX_RESULTS", 5)
        self.max_responses = self.read_int("MAX_RESPONSES", 50)
        self.visibility_threshold = self.read_float("VISIBILITY_THRESHOLD", 0.0)
        self.boost_factor = self.read_float("BOOST_FACTOR", 1.0)
        self.cache_enabled = self.read_flag("CACHE_ENABLED", True)

    def read_int(self, name, default):
        raw = self.environment.get(name)
        if raw is None:
            return default
        return int(raw)

    def read_float(self, name, default):
        raw = self.environment.get(name)
        if raw is None:
            return default
        return float(raw)

    def read_flag(self, name, default):
        raw = self.environment.get(name)
        if raw is None:
            return default
        return raw.lower() in ("1", "true", "yes")


def load_config():
    return RecommendationConfig(os.environ)
`,
  "services/catalog/client.py": `import json
import urllib.request


class Product:
    def __init__(self, payload):
        self.identifier = payload["id"]
        self.name = payload["name"]
        self.popularity_score = payload["popularity_score"]
        self.id_hash = payload["id_hash"]


class ProductCatalogClient:
    def __init__(self, base_url, timeout_seconds):
        self.base_url = base_url
        self.timeout_seconds = timeout_seconds

    def list_products(self):
        url = self.base_url + "/products"
        raw = self.fetch(url)
        payload = json.loads(raw)
        entries = payload["products"]
        return [Product(entry) for entry in entries]

    def fetch(self, url):
        with urllib.request.urlopen(url, timeout=self.timeout_seconds) as handle:
            return handle.read().decode("utf-8")
`,
};

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "liveprobe-payload-"));
  for (const [relative, source] of Object.entries(FILES)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source, "utf8");
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git("init", "-q");
  git("config", "user.email", "measure@example.com");
  git("config", "user.name", "measure");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return { root, commit: git("rev-parse", "HEAD") };
}

function analyzer(root, command) {
  return new Promise((done, fail) => {
    const child = spawn(python, ["-m", "liveprobe_analysis"], {
      cwd: root,
      env: { ...process.env, PYTHONPATH: analyzerSrc },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", () => {
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        fail(new Error(`analyzer produced no JSON: ${err || out}`));
        return;
      }
      if (parsed.ok !== true) {
        fail(new Error(parsed.error?.message ?? "analyzer command failed"));
        return;
      }
      done(parsed.result);
    });
    child.stdin.end(JSON.stringify({ ...command, repositoryRoot: root }));
  });
}

const { projectInvestigationView } = await import(
  join(repoRoot, "packages/mcp-server/dist/index.js")
);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

// The campaign ledger records `Buffer.byteLength(JSON.stringify(response))` of
// the whole JSON-RPC response, so quote the same basis here.
function wire(value, indent) {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(value, null, indent) }],
      },
    }),
  );
}

function compare(label, view) {
  const compact = projectInvestigationView(view, "compact");
  const full = bytes(view);
  const small = bytes(compact);
  console.log(
    `  ${label.padEnd(46)} full=${String(full).padStart(6)}B ` +
      `compact=${String(small).padStart(5)}B ` +
      `saved=${(((full - small) / full) * 100).toFixed(1)}%`,
  );
  console.log(
    `  ${"".padEnd(46)} wire before (full, indent 2) = ${String(
      wire(view, 2),
    ).padStart(6)}B   ` +
      `wire after (compact, no indent) = ${String(wire(compact)).padStart(6)}B` +
      `   saved=${(
        ((wire(view, 2) - wire(compact)) / wire(view, 2)) *
        100
      ).toFixed(1)}%`,
  );
  return small;
}

function fieldReport(label, view) {
  const total = bytes(view);
  const rows = Object.entries(view)
    .map(([key, value]) => [key, bytes(value)])
    .sort((left, right) => right[1] - left[1]);
  console.log(`\n${label}  total=${total}B  (pretty=${
    Buffer.byteLength(JSON.stringify(view, null, 2))
  }B)`);
  for (const [key, size] of rows) {
    const share = ((size / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${key.padEnd(20)} ${String(size).padStart(7)}B ${share}%`);
    if (key === "graph" && value_is_object(view.graph)) {
      for (const [inner, size2] of Object.entries(view.graph)
        .map(([k, v]) => [k, bytes(v)])
        .sort((left, right) => right[1] - left[1])) {
        console.log(`      graph.${inner.padEnd(26)} ${String(size2).padStart(7)}B`);
      }
    }
  }
  return { total, rows };
}

function value_is_object(value) {
  return typeof value === "object" && value !== null;
}

const { root, commit } = buildFixture();
try {
  await analyzer(root, { command: "prepare", commit });
  const started = await analyzer(root, {
    command: "start_investigation",
    criterion: {
      commit,
      serviceId: "recommend",
      file: "services/recommend/app.py",
      line: 24,
      symptom: "response_ids is empty for a session that should return results",
      watchPath: "response_ids",
      failureClass: "semantic",
      probeBudget: 5,
      sourceRoots: ["services"],
      ownershipMap: [
        { sourceRoot: "services/recommend", serviceId: "recommend" },
        { sourceRoot: "services/catalog", serviceId: "catalog" },
      ],
    },
  });
  fieldReport("start_probe_investigation (revision 1)", started);

  const investigationId = started.investigation_id;
  const sites = started.probe_bundle?.sites ?? [];
  const observations = sites.map((site, index) => ({
    observationId: `obs_${String(index).padStart(24, "0")}`,
    siteId: site.site_id,
    occurrenceId: "trace:measure-1",
    hitIndex: 1,
    sequenceIndex: index + 1,
    values: Object.fromEntries(
      site.watch_paths.map((path) => [path, { t: "seq", v: [] }]),
    ),
    captureStatus: "complete",
  }));
  const recorded = await analyzer(root, {
    command: "record_evidence",
    investigationId,
    observations,
  });
  fieldReport("collect_investigation_evidence .investigation", recorded);

  // Advance the loop so the view carries decision history, which is what grows
  // across a real multi-round investigation.
  let view = recorded;
  for (let step = 0; step < 6; step += 1) {
    const action = (view.actions ?? [])[0];
    if (action === undefined || view.phase !== "DECIDING") break;
    view = await analyzer(root, {
      command: "decide_investigation",
      investigationId,
      decision: {
        basedOnRevision: view.revision,
        actionIds: [action.action_id],
        evidenceRefs: [],
      },
    });
  }
  fieldReport(`view after decisions (revision ${view.revision})`, view);

  console.log("\ndecision-surface item counts (post-evidence view)");
  for (const key of [
    "actions",
    "value_dossiers",
    "judgments",
    "decision_log",
    "coverage_notes",
  ]) {
    const list = recorded[key] ?? [];
    console.log(
      `  ${key.padEnd(18)} n=${String(list.length).padStart(3)} ` +
        `${String(bytes(list)).padStart(6)}B ` +
        `per-item=${list.length ? Math.round(bytes(list) / list.length) : 0}B`,
    );
  }
  const bundleSites = recorded.probe_bundle?.sites ?? [];
  console.log(
    `  probe_bundle.sites n=${String(bundleSites.length).padStart(3)} ` +
      `${String(bytes(bundleSites)).padStart(6)}B ` +
      `per-item=${
        bundleSites.length ? Math.round(bytes(bundleSites) / bundleSites.length) : 0
      }B`,
  );
  for (const key of ["focus", "evidence", "actions", "traversals"]) {
    const part = recorded.decision_context?.[key];
    if (part === undefined) continue;
    console.log(
      `  decision_context.${key.padEnd(11)} ${String(bytes(part)).padStart(6)}B`,
    );
  }

  console.log("\ncompact projection (projectInvestigationView)");
  compare("start_probe_investigation", started);
  compare("collect_investigation_evidence .investigation", recorded);
  compare(`view after decisions (rev ${view.revision})`, view);
} finally {
  rmSync(root, { recursive: true, force: true });
}
