package io.liveprobe.bridge;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Protocol parsing and event mapping shared by the bridge and target-free tests. */
final class Protocol {
    private static final Set<String> CONDITION_OPERATORS = Set.of("eq", "ne", "gt", "gte", "lt", "lte");

    private Protocol() {}

    enum ProbeType {
        SNAPSHOT("snapshot", 1),
        LOG("log", 100),
        COUNTER("counter", 10_000),
        METRIC("metric", 10_000);

        private final String wireName;
        private final int defaultHitLimit;

        ProbeType(String wireName, int defaultHitLimit) {
            this.wireName = wireName;
            this.defaultHitLimit = defaultHitLimit;
        }

        String wireName() {
            return wireName;
        }

        int defaultHitLimit() {
            return defaultHitLimit;
        }

        static ProbeType parse(Object raw) {
            String value = requiredString(raw, "type");
            for (ProbeType type : values()) {
                if (type.wireName.equals(value)) {
                    return type;
                }
            }
            throw new ProtocolException("unsupported probe type: " + value);
        }
    }

    record Condition(String path, String op, Object value) {
        Condition {
            validatePath(path, "condition.path");
            if (!CONDITION_OPERATORS.contains(op)) {
                throw new ProtocolException("unsupported condition operator: " + op);
            }
            if (!isJsonScalar(value)) {
                throw new ProtocolException("condition.value must be a JSON scalar");
            }
        }
    }

    record ProbeDefinition(
            String id,
            String serviceId,
            ProbeType type,
            String file,
            int line,
            Condition condition,
            List<String> watchPaths,
            String template,
            String metricPath,
            int hitLimit,
            int ttlSeconds,
            long version,
            String createdBy) {
        ProbeDefinition {
            if (id == null || id.isBlank()) {
                throw new ProtocolException("probe id must not be empty");
            }
            if (serviceId == null || serviceId.isBlank()) {
                throw new ProtocolException("serviceId must not be empty");
            }
            Objects.requireNonNull(type, "type");
            if (file == null || file.isBlank()) {
                throw new ProtocolException("file must not be empty");
            }
            if (line <= 0 || hitLimit <= 0 || ttlSeconds <= 0 || version < 0) {
                throw new ProtocolException("line, hitLimit, and ttlSeconds must be positive");
            }
            watchPaths = List.copyOf(watchPaths);
            for (String watchPath : watchPaths) {
                validatePath(watchPath, "watchPaths");
            }
            if (type == ProbeType.LOG && (template == null || template.isBlank())) {
                throw new ProtocolException("log probes require template");
            }
            if (type == ProbeType.METRIC) {
                validatePath(metricPath, "metricPath");
            }
        }
    }

    record PollResponse(long version, boolean unchanged, List<ProbeDefinition> probes) {
        PollResponse {
            if (version < 0) {
                throw new ProtocolException("poll version must be non-negative");
            }
            probes = List.copyOf(probes);
        }
    }

    static PollResponse parsePoll(String json) {
        Map<String, Object> object = Json.parseObject(json);
        long version = integer(object.get("version"), "version", true);
        boolean unchanged = object.get("unchanged") instanceof Boolean value && value;
        ArrayList<ProbeDefinition> probes = new ArrayList<>();
        Object rawProbes = object.get("probes");
        if (rawProbes != null) {
            if (!(rawProbes instanceof List<?> list)) {
                throw new ProtocolException("probes must be an array");
            }
            for (Object item : list) {
                if (!(item instanceof Map<?, ?> map)) {
                    throw new ProtocolException("probe entries must be objects");
                }
                probes.add(parseProbe(Json.stringMap(map)));
            }
        } else if (!unchanged) {
            throw new ProtocolException("poll response requires probes or unchanged");
        }
        return new PollResponse(version, unchanged, probes);
    }

    static ProbeDefinition parseProbe(Map<String, Object> object) {
        ProbeType type = ProbeType.parse(object.get("type"));
        Condition condition = parseCondition(object.get("condition"));
        List<String> watchPaths = stringList(object.get("watchPaths"), "watchPaths");
        String template = optionalString(object.get("template"), "template");
        String metricPath = optionalString(object.get("metricPath"), "metricPath");
        int hitLimit = object.containsKey("hitLimit")
                ? positiveInteger(object.get("hitLimit"), "hitLimit")
                : type.defaultHitLimit();
        int ttlSeconds = object.containsKey("ttlSeconds")
                ? positiveInteger(object.get("ttlSeconds"), "ttlSeconds")
                : 1_800;
        return new ProbeDefinition(
                requiredString(object.get("id"), "id"),
                requiredString(object.get("serviceId"), "serviceId"),
                type,
                requiredString(object.get("file"), "file"),
                positiveInteger(object.get("line"), "line"),
                condition,
                watchPaths,
                template,
                metricPath,
                hitLimit,
                ttlSeconds,
                integer(object.get("version"), "version", true),
                requiredString(object.get("createdBy"), "createdBy"));
    }

    static Map<String, Object> statusEvent(String probeId, String status, String detail) {
        LinkedHashMap<String, Object> event = baseEvent(probeId, "status");
        event.put("status", status);
        if (detail != null && !detail.isBlank()) {
            event.put("detail", detail);
        }
        return event;
    }

    static Map<String, Object> snapshotEvent(
            String probeId,
            Map<String, Object> variables,
            Map<String, Object> watches,
            List<Map<String, Object>> stack) {
        LinkedHashMap<String, Object> event = baseEvent(probeId, "snapshot");
        event.put("variables", variables);
        event.put("watches", watches);
        event.put("stack", stack);
        return event;
    }

    static Map<String, Object> logEvent(String probeId, String message) {
        LinkedHashMap<String, Object> event = baseEvent(probeId, "log");
        event.put("message", message);
        event.put("level", "info");
        return event;
    }

    static Map<String, Object> counterEvent(String probeId, long delta) {
        LinkedHashMap<String, Object> event = baseEvent(probeId, "counter");
        event.put("delta", delta);
        return event;
    }

    static Map<String, Object> metricEvent(
            String probeId, long count, double sum, double min, double max, double last) {
        LinkedHashMap<String, Object> event = baseEvent(probeId, "metric");
        event.put("count", count);
        event.put("sum", sum);
        event.put("min", min);
        event.put("max", max);
        event.put("last", last);
        return event;
    }

    static Map<String, Object> ingestPayload(
            String serviceId,
            String commitSha,
            String commitSource,
            String state,
            String detail,
            List<Map<String, Object>> events) {
        LinkedHashMap<String, Object> agentStatus = new LinkedHashMap<>();
        agentStatus.put("state", state);
        if (detail != null && !detail.isBlank()) {
            agentStatus.put("detail", detail);
        }
        LinkedHashMap<String, Object> payload = new LinkedHashMap<>();
        payload.put("serviceId", serviceId);
        payload.put("sdk", "jvm");
        payload.put("commitSha", commitSha);
        payload.put("commitSource", commitSource);
        payload.put("agentStatus", agentStatus);
        payload.put("events", events);
        return payload;
    }

    private static LinkedHashMap<String, Object> baseEvent(String probeId, String type) {
        LinkedHashMap<String, Object> event = new LinkedHashMap<>();
        event.put("probeId", probeId);
        event.put("type", type);
        event.put("ts", Instant.now().toString());
        return event;
    }

    private static Condition parseCondition(Object raw) {
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> map)) {
            throw new ProtocolException("condition must be an object");
        }
        Map<String, Object> condition = Json.stringMap(map);
        return new Condition(
                requiredString(condition.get("path"), "condition.path"),
                requiredString(condition.get("op"), "condition.op"),
                condition.get("value"));
    }

    private static List<String> stringList(Object raw, String name) {
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw new ProtocolException(name + " must be an array");
        }
        ArrayList<String> values = new ArrayList<>();
        for (Object item : list) {
            values.add(requiredString(item, name));
        }
        return values;
    }

    private static int positiveInteger(Object raw, String name) {
        long value = integer(raw, name, false);
        if (value <= 0 || value > Integer.MAX_VALUE) {
            throw new ProtocolException(name + " must be a positive integer");
        }
        return (int) value;
    }

    private static long integer(Object raw, String name, boolean nonNegative) {
        if (!(raw instanceof Number number)) {
            throw new ProtocolException(name + " must be an integer");
        }
        BigDecimal decimal;
        try {
            decimal = new BigDecimal(number.toString());
            long value = decimal.longValueExact();
            if (nonNegative && value < 0) {
                throw new ProtocolException(name + " must be non-negative");
            }
            return value;
        } catch (NumberFormatException | ArithmeticException exception) {
            throw new ProtocolException(name + " must be an integer");
        }
    }

    private static String requiredString(Object raw, String name) {
        if (!(raw instanceof String value) || value.isBlank()) {
            throw new ProtocolException(name + " must be a non-empty string");
        }
        return value;
    }

    private static String optionalString(Object raw, String name) {
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof String value)) {
            throw new ProtocolException(name + " must be a string");
        }
        return value;
    }

    private static void validatePath(String path, String name) {
        if (path == null || path.isEmpty()) {
            throw new ProtocolException(name + " must be a non-empty dot path");
        }
        for (String segment : path.split("\\.", -1)) {
            if (segment.isEmpty()) {
                throw new ProtocolException(name + " contains an empty path segment");
            }
        }
    }

    private static boolean isJsonScalar(Object value) {
        if (value == null || value instanceof String || value instanceof Boolean) {
            return true;
        }
        if (value instanceof Double number) {
            return Double.isFinite(number);
        }
        if (value instanceof Float number) {
            return Float.isFinite(number);
        }
        return value instanceof Number;
    }

    static final class ProtocolException extends RuntimeException {
        ProtocolException(String message) {
            super(message);
        }
    }
}
