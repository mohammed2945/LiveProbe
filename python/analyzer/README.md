# LiveProbe Analysis

`liveprobe-analysis` runs beside the LiveProbe MCP server on an operator or
AI-SRE machine. It never runs inside an instrumented application.

It incrementally indexes Python source into two cached representations:
compact summaries for every function and full control-flow, def-use, and
hammock fragments loaded only for functions an investigation expands. Given a
manifestation line and value, it starts with that one function, exposes legal
upstream actions, and proposes a bounded bundle of ordinary LiveProbe snapshot
probes.

The persistent cache is operator-side and keyed by repository, deployed
revision, file content, and analyzer schema. Target services do not build or
hold code graphs. The first Python version models reaching definitions,
structured control dependence, conservative object/module-memory flow,
call/return ports, FastAPI/httpx boundaries, and Supabase durable read/write
boundaries. Every uncertain edge is labeled `MAY`; unselected branches remain
available rather than being pruned.

## Multi-resolution dependence graph

The statement-level dependence graph remains the lossless source of truth.
Each stateful investigation now derives four deterministic projections from
its manifestation-specific backward slice:

- `boundary`: runtime services and synthetic durable resources;
- `function`: expanded and still-collapsed function ports;
- `segment`: dependence-slice segments formed by contracting safe unbranched
  statement chains;
- `statement`: the original analyzed nodes.

Segment contraction never crosses a predicate, call, function or external
boundary, fan-in/fan-out point, cycle, or `MAY`/`UNKNOWN` relationship.
Every segment retains its canonical member node IDs, and every projected edge
retains its contributing edge count, kinds, paths, and worst certainty.
Expanding the segment view therefore recovers the original slice rather than
discarding alternatives.

Imported helpers are resolved through their module-qualified names, even when
they live outside the incident's initial `source_roots`. Static statement,
segment, and function regions are owner-neutral and are materialized once.
Separate runtime traversal records point to those regions and retain the
service, parent traversal, incoming call/boundary provenance, tracked paths,
and expansion status. A shared helper may therefore have one static function
region and several service-specific traversal records.

Local traversal steps preserve the current service. HTTP and durable steps use
the optional `ownership_map` to transition to the deployed producer service;
durable resources appear as explicit boundary nodes. Probe sites are addressed
by `(service_id, file, line)` and retain their traversal IDs, so a shared source
location can be deployed and observed independently in multiple services.
Hammocks remain presentation context and do not determine graph membership.

Each incident is a revisioned investigation ledger. Runtime captures from the
failing request become compact evidence rows with an explicit `UNKNOWN`
interpretation unless a configured type/shape or numeric-range predicate can
judge them mechanically. The external AI SRE chooses only analyzer-supplied
function or segment actions; it does not need to predict values while
exploring. Source is withheld until mechanism inspection. At that point the
AI SRE may submit one candidate mechanism whose anchors, traversal, probe
sites, watch paths, and expected observations are validated against the
ledger. Localization completes only when a fresh correlated occurrence
satisfies those predictions and also reaches the manifestation.

The model-facing decision context is distinct from analyzer storage. It uses
compact region aliases, failing-evidence deltas, runtime traversal
breadcrumbs, and legal actions under a 16 KiB default limit. Unsupported
builtins, raw source, repeated judgment records, and large object internals
are omitted from exploration packets.

V1 supports type/shape, domain/range, contract, and semantic-value incidents.
Absence/control-flow incidents return an explicit `INSUFFICIENT` verdict until
counter/control probe support is added.

The package uses newline-delimited JSON over stdin/stdout:

```sh
printf '%s\n' '{"command":"prepare","repositoryRoot":".","commit":"abcdef1"}' \
  | python -m liveprobe_analysis
```

Set `LIVEPROBE_ANALYSIS_CACHE` to choose the cache directory. By default the
package uses the platform cache directory under `liveprobe-analysis`.

Run the golden RideRush benchmark after the unit tests:

```sh
PYTHONPATH=python/analyzer/src \
  python3.12 python/analyzer/benchmarks/ride_sharing.py \
  --repository ../ride_sharing_probe_demo
```

The benchmark fails if the expected cross-service HTTP, durable-state, memory,
or conditional-value origin drops out of the slice/frontier, if a slice grows
beyond its precision budget, if cold indexing exceeds five seconds, if warm
indexing/querying exceeds one second, or if the cache exceeds 50 MiB.

Run the generated scale corpus:

```sh
PYTHONPATH=python/analyzer/src python3.12 \
  python/analyzer/benchmarks/scale_corpus.py \
  --functions 1000 5000 10000
```

Measure actual Python callback cost for one, five, and ten active snapshot
sites with `make python-probe-bundle-bench`. This is a local microbenchmark;
production budgets still need calibration against the application's hot paths
and captured object shapes.

The live RideRush probe/refinement run and the three probe-selection policy
tracks are documented in
[`demo/ride-analysis/README.md`](../../demo/ride-analysis/README.md).
