import { setTimeout as delay } from "node:timers/promises";

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function conditionIsTrue(conditions, type) {
  return conditions?.some(
    (condition) => condition.type === type && condition.status === "True",
  ) === true;
}

function containerNamed(spec, name) {
  return spec?.containers?.find((container) => container.name === name);
}

function envValue(container, name) {
  return container?.env?.find((entry) => entry.name === name)?.value;
}

export function activeEndpointPodNames(endpointSlices) {
  const names = [];
  const invalid = [];
  for (const slice of endpointSlices.items ?? []) {
    for (const endpoint of slice.endpoints ?? []) {
      if (
        (endpoint.addresses?.length ?? 0) === 0 ||
        endpoint.conditions?.ready === false ||
        endpoint.conditions?.serving === false ||
        endpoint.conditions?.terminating === true
      ) {
        continue;
      }
      const name =
        endpoint.targetRef?.kind === "Pod" ? endpoint.targetRef.name : undefined;
      if (typeof name !== "string" || name.length === 0) invalid.push(endpoint);
      else names.push(name);
    }
  }
  return { names: sorted(new Set(names)), invalid };
}

export function deploymentSelector(deployment) {
  const selector = deployment.spec?.selector;
  const terms = Object.entries(selector?.matchLabels ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  for (const expression of selector?.matchExpressions ?? []) {
    const values = sorted(expression.values ?? []);
    if (expression.operator === "In") {
      terms.push(`${expression.key} in (${values.join(",")})`);
    } else if (expression.operator === "NotIn") {
      terms.push(`${expression.key} notin (${values.join(",")})`);
    } else if (expression.operator === "Exists") {
      terms.push(expression.key);
    } else if (expression.operator === "DoesNotExist") {
      terms.push(`!${expression.key}`);
    } else {
      throw new Error(
        `unsupported Deployment selector operator ${expression.operator}`,
      );
    }
  }
  if (terms.length === 0) {
    throw new Error("recommendation Deployment has no pod selector");
  }
  return terms.join(",");
}

export function assessRecommendationConvergence({
  deployment,
  pods,
  endpointSlices,
  image,
  commit,
  allowUnready = false,
}) {
  const reasons = [];
  const desired = deployment.spec?.replicas ?? 1;
  const generation = deployment.metadata?.generation ?? 0;
  const observedGeneration = deployment.status?.observedGeneration ?? 0;
  const templateContainer = containerNamed(
    deployment.spec?.template?.spec,
    "recommendation",
  );
  if (desired < 1) reasons.push(`desired replicas is ${desired}, expected at least 1`);
  if (observedGeneration < generation) {
    reasons.push(
      `observed generation ${observedGeneration} is behind ${generation}`,
    );
  }
  if (templateContainer?.image !== image) {
    reasons.push(
      `Deployment template image is ${templateContainer?.image ?? "<missing>"}`,
    );
  }
  if (templateContainer?.imagePullPolicy !== "IfNotPresent") {
    reasons.push(
      `Deployment imagePullPolicy is ${templateContainer?.imagePullPolicy ?? "<missing>"}`,
    );
  }
  if (envValue(templateContainer, "LIVEPROBE_ENABLED") !== "on") {
    reasons.push("Deployment does not enable LiveProbe");
  }
  if (envValue(templateContainer, "LIVEPROBE_COMMIT_SHA") !== commit) {
    reasons.push("Deployment LiveProbe commit does not match extracted source");
  }

  const allPods = pods.items ?? [];
  const currentPods = allPods.filter(
    (pod) => pod.metadata?.deletionTimestamp === undefined,
  );
  const terminatingPods = allPods.filter(
    (pod) => pod.metadata?.deletionTimestamp !== undefined,
  );
  if (currentPods.length !== desired) {
    reasons.push(
      `found ${currentPods.length} current pods for ${desired} desired replicas`,
    );
  }
  for (const pod of currentPods) {
    const container = containerNamed(pod.spec, "recommendation");
    if (container?.image !== image) {
      reasons.push(
        `pod ${pod.metadata?.name ?? "<unknown>"} uses ${container?.image ?? "<missing>"}`,
      );
    }
    if (envValue(container, "LIVEPROBE_COMMIT_SHA") !== commit) {
      reasons.push(
        `pod ${pod.metadata?.name ?? "<unknown>"} has the wrong LiveProbe commit`,
      );
    }
    if (!allowUnready && !conditionIsTrue(pod.status?.conditions, "Ready")) {
      reasons.push(`pod ${pod.metadata?.name ?? "<unknown>"} is not Ready`);
    }
  }

  const endpointState = activeEndpointPodNames(endpointSlices);
  if (endpointState.invalid.length > 0) {
    reasons.push("an active recommendation endpoint does not target a Pod");
  }
  const currentPodNames = sorted(
    currentPods
      .map((pod) => pod.metadata?.name)
      .filter((name) => typeof name === "string"),
  );
  const currentPodNameSet = new Set(currentPodNames);
  const staleEndpointNames = endpointState.names.filter(
    (name) => !currentPodNameSet.has(name),
  );
  if (staleEndpointNames.length > 0) {
    reasons.push(
      `active endpoints still target stale pods: ${staleEndpointNames.join(",")}`,
    );
  }

  if (!allowUnready) {
    const status = deployment.status ?? {};
    for (const [name, value] of [
      ["replicas", status.replicas ?? 0],
      ["updatedReplicas", status.updatedReplicas ?? 0],
      ["readyReplicas", status.readyReplicas ?? 0],
      ["availableReplicas", status.availableReplicas ?? 0],
    ]) {
      if (value !== desired) {
        reasons.push(`Deployment ${name} is ${value}, expected ${desired}`);
      }
    }
    if ((status.unavailableReplicas ?? 0) !== 0) {
      reasons.push(
        `Deployment has ${status.unavailableReplicas} unavailable replicas`,
      );
    }
    if (
      JSON.stringify(endpointState.names) !== JSON.stringify(currentPodNames)
    ) {
      reasons.push(
        `ready endpoint pods ${JSON.stringify(endpointState.names)} do not equal current pods ${JSON.stringify(currentPodNames)}`,
      );
    }
    if (terminatingPods.length > 0) {
      reasons.push(
        `waiting for ${terminatingPods.length} terminating rollout pod(s)`,
      );
    }
  }

  return {
    converged: reasons.length === 0,
    reasons,
    generation,
    observedGeneration,
    desiredReplicas: desired,
    currentPodNames,
    terminatingPodNames: sorted(
      terminatingPods
        .map((pod) => pod.metadata?.name)
        .filter((name) => typeof name === "string"),
    ),
    endpointPodNames: endpointState.names,
    image,
    commit,
    allowUnready,
  };
}

export async function waitForRecommendationConvergence(
  readState,
  {
    image,
    commit,
    allowUnready = false,
    timeoutMs = 180_000,
    pollMs = 500,
    stableChecks = 5,
  },
) {
  const deadline = Date.now() + timeoutMs;
  let lastAssessment;
  let priorSignature;
  let consecutive = 0;
  while (Date.now() < deadline) {
    try {
      const state = await readState();
      lastAssessment = assessRecommendationConvergence({
        ...state,
        image,
        commit,
        allowUnready,
      });
      const signature = JSON.stringify({
        generation: lastAssessment.generation,
        observedGeneration: lastAssessment.observedGeneration,
        currentPodNames: lastAssessment.currentPodNames,
        terminatingPodNames: lastAssessment.terminatingPodNames,
        endpointPodNames: lastAssessment.endpointPodNames,
      });
      if (lastAssessment.converged && signature === priorSignature) {
        consecutive += 1;
      } else {
        consecutive = lastAssessment.converged ? 1 : 0;
      }
      priorSignature = signature;
      if (consecutive >= stableChecks) return lastAssessment;
    } catch (error) {
      lastAssessment = {
        converged: false,
        reasons: [String(error.message ?? error)],
      };
      consecutive = 0;
      priorSignature = undefined;
    }
    await delay(pollMs);
  }
  throw new Error(
    `recommendation rollout did not converge for ${stableChecks} stable checks within ${timeoutMs}ms: ${JSON.stringify(lastAssessment)}`,
  );
}
