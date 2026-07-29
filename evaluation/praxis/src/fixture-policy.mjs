function edge(from, to, evidenceIds, explanation) {
  return {
    from,
    to,
    evidence_ids: evidenceIds,
    explanation,
  };
}

export function fixtureDiagnosis(incidentId, arm) {
  if (incidentId === "401") {
    return {
      status: "LOCALIZED",
      root_cause: {
        entity: "recommendation",
        kind: "Service",
        service: "recommendation",
        file: "recommendation_server.py",
        line: 85,
        function: "get_product_list",
        namespace: "otel-demo",
        resource: null,
        config_path: null,
      },
      mechanism:
        "The deployed recommendation code reads products_list from a successful product-catalog response whose schema does not provide that field.",
      propagation: [
        edge(
          "recommendation",
          "frontend",
          ["trace_401", "log_401_2", "log_401_3"],
          "Recommendation raises while decoding the catalog response and its upstream frontend request fails.",
        ),
      ],
      remediation:
        "Align the recommendation response-field access with the deployed product-catalog schema.",
      confidence: arm === "graph_liveprobe" ? 0.99 : 0.94,
    };
  }
  if (incidentId === "405") {
    const liveProbeArm =
      arm === "graph_liveprobe" || arm === "raw_liveprobe";
    return {
      status: liveProbeArm ? "HANDOFF" : "LOCALIZED",
      root_cause: {
        entity: "neo4j-productdb",
        kind: "ServiceBoundary",
        service: "neo4j-productdb",
        file: null,
        line: null,
        function: null,
        namespace: "otel-demo",
        resource: "neo4j-productdb",
        config_path: null,
      },
      mechanism:
        "The recommendation request waits indefinitely on the external product database, consuming almost the complete failed trace duration.",
      propagation: [
        edge(
          "neo4j-productdb",
          "recommendation",
          ["trace_405", "log_405_1"],
          "The database child span remains unresolved while recommendation waits.",
        ),
        edge(
          "recommendation",
          "frontend",
          ["trace_405", "log_405_2"],
          "The blocked recommendation call exceeds the frontend deadline.",
        ),
      ],
      remediation:
        "Restore the database and add a bounded timeout and fallback at the recommendation boundary.",
      confidence: liveProbeArm ? 0.96 : 0.92,
    };
  }
  if (incidentId === "3") {
    return {
      status: "LOCALIZED",
      root_cause: {
        entity: "flagd-config",
        kind: "ConfigMap",
        service: "ad",
        file: null,
        line: null,
        function: null,
        namespace: "otel-demo",
        resource: "flagd-config",
        config_path: "flags.adHighCpu",
      },
      mechanism:
        "A recent feature-flag ConfigMap change activates the ad-service high-CPU behavior, saturating the ad request path.",
      propagation: [
        edge(
          "flagd-config",
          "ad",
          ["event_3_flagd_config", "resource_3_flagd", "metric_3_ad_cpu"],
          "The configuration changed before ad CPU reached saturation.",
        ),
        edge(
          "ad",
          "frontend",
          ["trace_3", "log_3_1"],
          "The saturated ad child request fails the frontend trace.",
        ),
      ],
      remediation: "Disable the ad high-CPU feature flag.",
      confidence: 0.9,
    };
  }
  throw new Error(`no fixture policy for incident ${incidentId}`);
}
