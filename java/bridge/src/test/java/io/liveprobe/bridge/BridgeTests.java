package io.liveprobe.bridge;

import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.StackFrame;

import java.io.IOException;
import java.lang.reflect.Proxy;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.LongSupplier;

/** Dependency-free targetless test suite. */
public final class BridgeTests {
    private static int assertions;

    private BridgeTests() {}

    public static void main(String[] args) throws Exception {
        testJson();
        testSerializerFixtures();
        testConditions();
        testProtocolMapping();
        testStackLocalOptions();
        testLogLevels();
        testSafeExpressionEvaluation();
        testSharedExpressionFixture();
        testSafeExpressionValidation();
        testExpressionIntegrations();
        testIngestRetryClassification();
        testBrokerRoutingHeaders();
        testCanonicalSafetyConfiguration();
        testRateLimiter();
        testRateLimitedCounters();
        testFalseThenTrueHitLimit();
        testConcurrentMatchingSlots();
        testStackLineFiltering();
        testStackLocals();
        testStackLocalReadBound();
        testAbsentStackLocalInfo();
        System.out.println("BridgeTests: " + assertions + " assertions passed");
    }

    private static void testJson() {
        String source = "{\"message\":\"line\\n\\u263a\",\"values\":[1,-2.5e2,true,null]}";
        Object parsed = Json.parse(source);
        Object reparsed = Json.parse(Json.stringify(parsed));
        assertDeepEquals(parsed, reparsed, "JSON round trip");
        assertThrows(() -> Json.parse("{\"a\":1,\"a\":2}"), "duplicate keys rejected");
        assertThrows(() -> Json.parse("[01]"), "leading zero rejected");
        assertThrows(() -> Json.stringify(Double.NaN), "non-finite number rejected");
    }

    private static void testBrokerRoutingHeaders() throws Exception {
        BrokerClient client = new BrokerClient(
                URI.create("https://broker.example"),
                "service",
                "test-key",
                "abcdef1234567890",
                "config",
                "acquireiq",
                "production");
        HttpRequest.Builder builder = HttpRequest.newBuilder(
                URI.create("https://broker.example/v1/services"));
        HttpRequest request = client.withAuth(builder).GET().build();

        assertEquals(
                "Bearer test-key",
                request.headers().firstValue("Authorization").orElse(null),
                "broker authorization header");
        assertEquals(
                "acquireiq",
                request.headers().firstValue("LiveProbe-Project").orElse(null),
                "broker project header");
        assertEquals(
                "production",
                request.headers().firstValue("LiveProbe-Environment").orElse(null),
                "broker environment header");
    }

    private static void testCanonicalSafetyConfiguration() {
        BridgeConfig config = BridgeConfig.parse(new String[] {
                "--service", "inventory",
                "--attach", "127.0.0.1:5005",
                "--broker", "https://broker.example",
                "--commit", "abcdef1234567890",
                "--max-probe-hits-per-second", "12"
        });
        assertEquals(12, config.hitsPerSecond(), "canonical hit limit flag");

        assertThrows(
                () -> BridgeConfig.parse(new String[] {
                        "--service", "inventory",
                        "--attach", "127.0.0.1:5005",
                        "--broker", "https://broker.example",
                        "--commit", "abcdef1234567890",
                        "--max-probe-hits-per-second", "12",
                        "--hits-per-second", "10"
                }),
                "conflicting canonical and legacy hit limits rejected");
    }

    private static void testSerializerFixtures() throws IOException {
        Path fixtureDirectory = fixtureDirectory();
        for (String fixtureName : List.of(
                "nested-secrets.json",
                "deep-object.json",
                "long-array.json",
                "circular.json",
                "redact-values.json",
                "mixed-kitchen-sink.json")) {
            Map<String, Object> fixture = Json.parseObject(
                    Files.readString(fixtureDirectory.resolve(fixtureName)));
            FixtureMaterializer materializer = new FixtureMaterializer();
            Object raw = materializer.materialize(fixture.get("input"));
            Map<String, Object> config = fixture.get("config") instanceof Map<?, ?> map
                    ? Json.stringMap(map)
                    : Map.of();
            Map<String, Object> actual =
                    SafeSerializer.serialize(raw, SafeSerializer.Config.fromJson(config));
            assertDeepEquals(fixture.get("expected"), actual, "serializer fixture " + fixtureName);
        }
        assertEquals(
                "redacted",
                SafeSerializer.serializePath(
                        "password.hash", "must-not-escape", SafeSerializer.Config.defaults()).get("t"),
                "watch paths redact every segment");
    }

    private static void testConditions() {
        LinkedHashMap<String, Object> cart = new LinkedHashMap<>();
        cart.put("total", 5_001L);
        cart.put("label", "5001");
        LinkedHashMap<String, Object> variables = new LinkedHashMap<>();
        variables.put("cart", cart);
        variables.put("enabled", true);
        variables.put("nullable", null);

        assertTrue(ConditionEvaluator.evaluate(
                variables, new Protocol.Condition("cart.total", "gt", 5_000L)), "numeric gt");
        assertTrue(ConditionEvaluator.evaluate(
                variables, new Protocol.Condition("cart.total", "eq", new BigDecimal("5001.0"))),
                "JSON number equality");
        assertFalse(ConditionEvaluator.evaluate(
                variables, new Protocol.Condition("cart.label", "eq", 5_001L)), "no coercion");
        assertFalse(ConditionEvaluator.evaluate(
                variables, new Protocol.Condition("missing", "ne", "value")), "missing ne is false");
        assertFalse(ConditionEvaluator.evaluate(
                variables, new Protocol.Condition("enabled", "lt", 2L)), "ordering requires numbers");
        assertTrue(ConditionEvaluator.evaluate(
                variables, new Protocol.Condition("nullable", "eq", null)), "null equality");
    }

    private static void testProtocolMapping() {
        String pollJson = """
                {
                  "version": 9,
                  "probes": [{
                    "id": "prb_test",
                    "serviceId": "inventory-service",
                    "type": "metric",
                    "file": "src/main/java/example/Inventory.java",
                    "line": 42,
                    "condition": {"path": "item.active", "op": "eq", "value": true},
                    "metricPath": "cache.age",
                    "hitLimit": 25,
                    "ttlSeconds": 1800,
                    "version": 9,
                    "createdBy": "mcp:test"
                  }]
                }
                """;
        Protocol.PollResponse response = Protocol.parsePoll(pollJson);
        assertEquals(9L, response.version(), "poll version");
        assertEquals(Protocol.ProbeType.METRIC, response.probes().get(0).type(), "probe type");
        assertEquals("cache.age", response.probes().get(0).metricPath(), "metric path");

        Map<String, Object> status = Protocol.statusEvent("prb_test", "armed", "Inventory.java:42");
        Map<String, Object> payload = Protocol.ingestPayload(
                "inventory-service", "agent-jvm-test", "abcdef1234567890", "config",
                "red", "1 breakpoint request(s) rate-limited", "rate_limited", 10,
                List.of(status));
        Map<String, Object> decoded = Json.parseObject(Json.stringify(payload));
        assertEquals("jvm", decoded.get("sdk"), "JVM SDK mapping");
        assertEquals("inventory-service", decoded.get("serviceId"), "service mapping");
        assertEquals("agent-jvm-test", decoded.get("agentId"), "agent instance mapping");
        assertEquals("abcdef1234567890", decoded.get("commitSha"), "commit SHA mapping");
        assertEquals("config", decoded.get("commitSource"), "commit source mapping");
        assertEquals(
                List.of(
                        "log-levels-v1",
                        "expression-ast-v1",
                        "frame-locals-v1",
                        "safety-report-v1"),
                decoded.get("capabilities"),
                "capability mapping");
        Map<String, Object> agentStatus =
                Json.stringMap((Map<?, ?>) decoded.get("agentStatus"));
        assertEquals("red", agentStatus.get("state"), "safety state mapping");
        assertEquals(
                "rate_limited",
                agentStatus.get("reasonCode"),
                "safety reason mapping");
        assertEquals(
                Map.of("maxProbeHitsPerSecond", 10L),
                agentStatus.get("limits"),
                "safety limits mapping");
        Object events = decoded.get("events");
        assertTrue(events instanceof List<?> list && list.size() == 1, "status event mapping");
    }

    private static void testStackLocalOptions() {
        Protocol.ProbeDefinition defaults =
                Protocol.parseProbe(probeObject("prb_stack_defaults", "snapshot"));
        assertFalse(defaults.includeStackLocals(), "stack locals default to disabled");
        assertEquals(3, defaults.stackFrameLimit(), "stack frame limit defaults to three");

        Map<String, Object> configured = probeObject("prb_stack_configured", "snapshot");
        configured.put("includeStackLocals", true);
        configured.put("stackFrameLimit", 8L);
        Protocol.ProbeDefinition parsed = Protocol.parseProbe(configured);
        assertTrue(parsed.includeStackLocals(), "stack locals parse as enabled");
        assertEquals(8, parsed.stackFrameLimit(), "maximum stack frame limit is accepted");

        Map<String, Object> invalidFlag = probeObject("prb_stack_flag", "snapshot");
        invalidFlag.put("includeStackLocals", "true");
        assertThrows(
                () -> Protocol.parseProbe(invalidFlag),
                "non-boolean stack locals flag rejected");

        for (Object invalidLimit : List.of(0L, 9L, 1.5d)) {
            Map<String, Object> invalid = probeObject("prb_stack_limit", "snapshot");
            invalid.put("stackFrameLimit", invalidLimit);
            assertThrows(
                    () -> Protocol.parseProbe(invalid),
                    "invalid stack frame limit rejected: " + invalidLimit);
        }
    }

    private static void testLogLevels() {
        for (String level : List.of("debug", "info", "warn", "error")) {
            Protocol.ProbeDefinition probe = Protocol.parseProbe(logProbeObject(level));
            assertEquals(level, probe.logLevel().wireName(), "log level " + level + " parsed");
        }

        Map<String, Object> legacyDefinition = logProbeObject(null);
        Protocol.ProbeDefinition legacyProbe = Protocol.parseProbe(legacyDefinition);
        assertEquals(
                Protocol.LogLevel.INFO,
                legacyProbe.logLevel(),
                "omitted log level defaults to info");

        Map<String, Object> invalidDefinition = logProbeObject("critical");
        assertThrows(
                () -> Protocol.parseProbe(invalidDefinition),
                "unsupported log level rejected");

        Protocol.ProbeDefinition warningProbe =
                Protocol.parseProbe(logProbeObject("warn"));
        EventBuffer events = new EventBuffer(10);
        HitProcessor processor = new HitProcessor(
                SafeSerializer.Config.defaults(), events, new AggregationStore());
        processor.process(
                new RawHit(warningProbe, Map.of("orderId", 42L), List.of()),
                new EmittedSlots(1),
                () -> {});

        List<Map<String, Object>> emitted = events.drain();
        assertEquals(1, emitted.size(), "log hit emits one event");
        assertEquals("Order 42", emitted.get(0).get("message"), "log template is rendered");
        assertEquals("warn", emitted.get(0).get("level"), "configured log level is emitted");

        Map<String, Object> legacyEvent =
                Protocol.logEvent("prb_log", "legacy", legacyProbe.logLevel());
        assertEquals("info", legacyEvent.get("level"), "legacy log event emits info");
    }

    private static Map<String, Object> logProbeObject(String level) {
        Map<String, Object> probe = probeObject("prb_log", "log");
        probe.put("template", "Order ${orderId}");
        if (level != null) {
            probe.put("logLevel", level);
        }
        return probe;
    }

    private static void testSafeExpressionEvaluation() {
        LinkedHashMap<String, Object> variables = new LinkedHashMap<>();
        variables.put("a", 10L);
        variables.put("b", 4L);
        variables.put("text", "live");
        variables.put("enabled", true);
        variables.put("items", List.of(Map.of("price", 3L), Map.of("price", 7L)));
        variables.put(
                "summary",
                new JdiObjectSummary("Order", Map.of("total", 10.0d)));

        assertExpressionEquals(7L, reference("items", 1L, "price"), variables, "list reference");
        assertExpressionEquals(
                3L, reference("items", "0", "price"), variables, "fixed string list index");
        assertExpressionEquals(
                10.0d, reference("summary", "total"), variables, "captured JDI field reference");
        assertExpressionEquals(false, unary("not", reference("enabled")), variables, "boolean not");
        assertExpressionEquals(-10.0d, unary("negate", reference("a")), variables, "numeric negate");
        assertExpressionEquals(
                14.0d, binary("add", reference("a"), reference("b")), variables, "numeric add");
        assertExpressionEquals(
                "liveprobe",
                binary("add", reference("text"), literal("probe")),
                variables,
                "string add");
        assertExpressionEquals(
                6.0d, binary("subtract", reference("a"), reference("b")), variables, "subtract");
        assertExpressionEquals(
                40.0d, binary("multiply", reference("a"), reference("b")), variables, "multiply");
        assertExpressionEquals(
                2.5d, binary("divide", reference("a"), reference("b")), variables, "divide");
        assertExpressionEquals(
                2.0d, binary("modulo", reference("a"), reference("b")), variables, "modulo");
        assertExpressionEquals(
                true, binary("eq", reference("a"), literal(10.0d)), variables, "numeric equality");
        assertExpressionEquals(
                true, binary("ne", reference("a"), literal("10")), variables, "strict inequality");
        assertExpressionEquals(
                true, binary("gt", reference("a"), reference("b")), variables, "greater than");
        assertExpressionEquals(
                true, binary("gte", reference("a"), literal(10L)), variables, "greater or equal");
        assertExpressionEquals(
                true, binary("lt", reference("b"), reference("a")), variables, "less than");
        assertExpressionEquals(
                true, binary("lte", reference("a"), literal(10L)), variables, "less or equal");
        assertExpressionEquals(
                false,
                binary("and", literal(false), reference("missing")),
                variables,
                "and short circuits");
        assertExpressionEquals(
                true,
                binary("or", literal(true), reference("missing")),
                variables,
                "or short circuits");

        assertExpressionError(
                "expected-boolean",
                binary("and", reference("a"), literal(true)),
                variables,
                "boolean operators are strict");
        assertExpressionError(
                "division-by-zero",
                binary("divide", reference("a"), literal(0L)),
                variables,
                "division by zero fails");
        assertExpressionError(
                "missing", reference("missing"), variables, "missing reference fails");
        assertExpressionError(
                "redacted", reference("apiToken"), Map.of("apiToken", "secret"), "redacted path fails");
    }

    private static void testSharedExpressionFixture() throws IOException {
        Map<String, Object> fixture =
                Json.parseObject(Files.readString(expressionFixturePath()));
        Object rawCases = fixture.get("cases");
        if (!(rawCases instanceof List<?> cases)) {
            throw new AssertionError("expression fixture cases must be an array");
        }
        for (int index = 0; index < cases.size(); index++) {
            Map<String, Object> fixtureCase = Json.stringMap((Map<?, ?>) cases.get(index));
            String name = String.valueOf(fixtureCase.get("name"));
            Map<String, Object> root = Json.stringMap((Map<?, ?>) fixtureCase.get("root"));
            SafeExpression.Compiled expression = SafeExpression.parseCompiled(
                    fixtureCase.get("expression"), "cases[" + index + "].expression");
            Map<String, Object> expected =
                    Json.stringMap((Map<?, ?>) fixtureCase.get("expected"));
            SafeExpression.Result actual = SafeExpression.evaluate(
                    expression, root, SafeSerializer.Config.defaults());
            assertEquals(expected.get("ok"), actual.ok(), "expression fixture " + name + " status");
            if (actual.ok()) {
                assertDeepEquals(
                        expected.get("value"),
                        actual.value(),
                        "expression fixture " + name + " value");
            } else {
                assertEquals(
                        expected.get("error"),
                        actual.error(),
                        "expression fixture " + name + " error");
            }
        }
    }

    private static void testSafeExpressionValidation() {
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject("bad()", Map.of("type", "call")), "expression"),
                "unsupported AST node rejected");
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject(
                                "value",
                                Map.of(
                                        "type", "reference",
                                        "path", List.of("value"),
                                        "extra", true)),
                        "expression"),
                "extra AST fields rejected");
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject(
                                "value.constructor",
                                Map.of("type", "reference", "path", List.of("value", "constructor"))),
                        "expression"),
                "forbidden reference segment rejected");
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject(
                                "items[-1]",
                                Map.of("type", "reference", "path", List.of("items", -1L))),
                        "expression"),
                "negative reference index rejected");
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject(
                                "items[1.5]",
                                Map.of("type", "reference", "path", List.of("items", 1.5d))),
                        "expression"),
                "fractional reference index rejected");

        ArrayList<Object> longPath = new ArrayList<>();
        for (int index = 0; index < 65; index++) {
            longPath.add("p" + index);
        }
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject(
                                "long.path",
                                Map.of("type", "reference", "path", longPath)),
                        "expression"),
                "path segment limit enforced");

        Object deep = Map.of("type", "literal", "value", true);
        for (int depth = 0; depth < 22; depth++) {
            deep = Map.of("type", "unary", "operator", "not", "operand", deep);
        }
        Object tooDeep = deep;
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject("deep", tooDeep), "expression"),
                "AST depth limit enforced");

        Object wide = wideTree(7);
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject("wide", wide), "expression"),
                "AST node limit enforced");
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject(
                                "bad",
                                Map.of(
                                        "type", "binary",
                                        "operator", "call",
                                        "left", Map.of("type", "literal", "value", 1L),
                                        "right", Map.of("type", "literal", "value", 2L))),
                        "expression"),
                "unsupported operator rejected");

        LinkedHashMap<String, Object> nonFiniteLiteral = new LinkedHashMap<>();
        nonFiniteLiteral.put("type", "literal");
        nonFiniteLiteral.put("value", Double.NaN);
        assertThrows(
                () -> SafeExpression.parseCompiled(
                        compiledObject("nan", nonFiniteLiteral), "expression"),
                "non-finite literal rejected");
    }

    private static void testExpressionIntegrations() {
        Map<String, Object> snapshotObject = probeObject("prb_expression_snapshot", "snapshot");
        snapshotObject.put(
                "conditionExpression",
                compiledObject(
                        "total > 10",
                        binaryObject("gt", referenceObject("total"), literalObject(10L))));
        snapshotObject.put(
                "watchExpressions",
                List.of(
                        compiledObject(
                                "items[1].price + 2",
                                binaryObject(
                                        "add",
                                        referenceObject("items", 1L, "price"),
                                        literalObject(2L))),
                        compiledObject(
                                "missing + 1",
                                binaryObject(
                                        "add",
                                        referenceObject("missing"),
                                        literalObject(1L)))));
        Protocol.ProbeDefinition snapshot = Protocol.parseProbe(snapshotObject);
        EventBuffer snapshotEvents = new EventBuffer(10);
        HitProcessor snapshotProcessor = new HitProcessor(
                SafeSerializer.Config.defaults(), snapshotEvents, new AggregationStore());
        snapshotProcessor.process(
                new RawHit(snapshot, Map.of("total", 9L), List.of()),
                new EmittedSlots(2),
                () -> {});
        assertEquals(0, snapshotEvents.drain().size(), "false expression condition emits nothing");
        snapshotProcessor.process(
                new RawHit(
                        snapshot,
                        Map.of(
                                "total", 12L,
                                "items", List.of(Map.of("price", 1L), Map.of("price", 5L))),
                        List.of()),
                new EmittedSlots(2),
                () -> {});
        Map<String, Object> snapshotEvent = snapshotEvents.drain().get(0);
        Map<String, Object> watches =
                Json.stringMap((Map<?, ?>) snapshotEvent.get("watches"));
        assertEquals(
                7.0d,
                Json.stringMap((Map<?, ?>) watches.get("items[1].price + 2")).get("v"),
                "watch expression value emitted");
        assertEquals(
                "unsupported",
                Json.stringMap((Map<?, ?>) watches.get("missing + 1")).get("v"),
                "watch expression errors use unsupported marker");

        Map<String, Object> logObject = probeObject("prb_expression_log", "log");
        logObject.put("template", "Total expression");
        logObject.put("logLevel", "debug");
        logObject.put(
                "templateSegments",
                List.of(
                        Map.of("type", "text", "value", "Total "),
                        Map.of(
                                "type", "expression",
                                "expression", compiledObject(
                                        "total * 2",
                                        binaryObject(
                                                "multiply",
                                                referenceObject("total"),
                                                literalObject(2L)))),
                        Map.of("type", "text", "value", ", bad "),
                        Map.of(
                                "type", "expression",
                                "expression", compiledObject(
                                        "total / 0",
                                        binaryObject(
                                                "divide",
                                                referenceObject("total"),
                                                literalObject(0L))))));
        Protocol.ProbeDefinition logProbe = Protocol.parseProbe(logObject);
        EventBuffer logEvents = new EventBuffer(10);
        new HitProcessor(
                        SafeSerializer.Config.defaults(), logEvents, new AggregationStore())
                .process(
                        new RawHit(logProbe, Map.of("total", 6L), List.of()),
                        new EmittedSlots(1),
                        () -> {});
        Map<String, Object> logEvent = logEvents.drain().get(0);
        assertEquals(
                "Total 12, bad <expression-error:division-by-zero>",
                logEvent.get("message"),
                "compiled log segments render values and bounded errors");
        assertEquals("debug", logEvent.get("level"), "expression log retains configured level");

        Map<String, Object> metricObject = probeObject("prb_expression_metric", "metric");
        metricObject.put(
                "metricExpression",
                compiledObject(
                        "total / count",
                        binaryObject(
                                "divide",
                                referenceObject("total"),
                                referenceObject("count"))));
        Protocol.ProbeDefinition metricProbe = Protocol.parseProbe(metricObject);
        AggregationStore metricAggregations = new AggregationStore();
        EventBuffer metricEvents = new EventBuffer(10);
        new HitProcessor(
                        SafeSerializer.Config.defaults(), metricEvents, metricAggregations)
                .process(
                        new RawHit(metricProbe, Map.of("total", 15L, "count", 3L), List.of()),
                        new EmittedSlots(1),
                        () -> {});
        List<Map<String, Object>> aggregates = metricAggregations.drain();
        assertEquals(1, aggregates.size(), "valid metric expression is aggregated");
        assertEquals(5.0d, aggregates.get(0).get("last"), "metric expression sample emitted");
        assertEquals(0, metricEvents.drain().size(), "valid metric expression emits no error");

        Map<String, Object> invalidMetricObject =
                probeObject("prb_expression_metric_invalid", "metric");
        invalidMetricObject.put(
                "metricExpression",
                compiledObject(
                        "total / count",
                        binaryObject(
                                "divide",
                                referenceObject("total"),
                                referenceObject("count"))));
        Protocol.ProbeDefinition invalidMetric = Protocol.parseProbe(invalidMetricObject);
        AggregationStore invalidAggregations = new AggregationStore();
        EventBuffer invalidEvents = new EventBuffer(10);
        new HitProcessor(
                        SafeSerializer.Config.defaults(), invalidEvents, invalidAggregations)
                .process(
                        new RawHit(invalidMetric, Map.of("total", 15L, "count", 0L), List.of()),
                        new EmittedSlots(1),
                        () -> {});
        assertEquals(0, invalidAggregations.drain().size(), "invalid metric sample is dropped");
        Map<String, Object> invalidEvent = invalidEvents.drain().get(0);
        assertEquals("status", invalidEvent.get("type"), "invalid metric emits probe status");
        assertEquals("error", invalidEvent.get("status"), "invalid metric status is error");
        assertTrue(
                String.valueOf(invalidEvent.get("detail")).contains("division-by-zero"),
                "invalid metric status includes evaluation reason");
    }

    private static void testRateLimitedCounters() {
        Protocol.ProbeDefinition plain =
                Protocol.parseProbe(probeObject("prb_hot_counter", "counter"));
        Map<String, Object> conditionalObject = probeObject("prb_cond_counter", "counter");
        conditionalObject.put("condition", Map.of("path", "amount", "op", "gt", "value", 0L));
        Protocol.ProbeDefinition conditional = Protocol.parseProbe(conditionalObject);
        Protocol.ProbeDefinition snapshot =
                Protocol.parseProbe(probeObject("prb_snapshot", "snapshot"));

        assertTrue(HitProcessor.isPlainCounter(plain), "unconditional counter needs no capture");
        assertFalse(
                HitProcessor.isPlainCounter(conditional),
                "conditional counter must capture to evaluate its condition");
        assertFalse(HitProcessor.isPlainCounter(snapshot), "snapshot is not a counter");

        // The breakpoint event that tripped the budget has already been
        // delivered, so its hit is countable even though nothing was captured.
        AggregationStore aggregations = new AggregationStore();
        HitProcessor processor =
                new HitProcessor(
                        SafeSerializer.Config.defaults(), new EventBuffer(10), aggregations);
        processor.countWithoutCapture(plain, new EmittedSlots(2), () -> {});
        processor.countWithoutCapture(plain, new EmittedSlots(2), () -> {});
        List<Map<String, Object>> counted = aggregations.drain();
        assertEquals(1, counted.size(), "rate-limited counter aggregates");
        assertEquals(2L, counted.get(0).get("delta"), "every delivered hit is counted");

        // Counting still consumes the hit limit and retires the probe with it.
        AggregationStore limited = new AggregationStore();
        EmittedSlots slots = new EmittedSlots(1);
        boolean[] retired = {false};
        HitProcessor limitProcessor =
                new HitProcessor(SafeSerializer.Config.defaults(), new EventBuffer(10), limited);
        limitProcessor.countWithoutCapture(plain, slots, () -> retired[0] = true);
        limitProcessor.countWithoutCapture(plain, slots, () -> retired[0] = true);
        assertTrue(retired[0], "hit limit reached while rate limited");
        assertEquals(1L, limited.drain().get(0).get("delta"), "hit limit bounds the count");
    }

    private static void testRateLimiter() {
        MutableNanoClock clock = new MutableNanoClock();
        RateLimiter limiter = new RateLimiter(2, clock);
        assertTrue(limiter.tryAcquire(), "first permit");
        assertTrue(limiter.tryAcquire(), "second permit");
        assertFalse(limiter.tryAcquire(), "limit enforced");
        assertTrue(limiter.nanosUntilReset() > 0, "reset delay reported");
        clock.advance(TimeUnit.SECONDS.toNanos(1));
        assertTrue(limiter.tryAcquire(), "new window permits");
        assertEquals(1, limiter.remaining(), "remaining permits");
    }

    private static void testIngestRetryClassification() {
        BrokerIngestException rejected = new BrokerIngestException(400);
        BrokerIngestException unavailable = new BrokerIngestException(503);

        assertTrue(rejected.isNonRetryable(), "invalid ingest is non-retryable");
        assertFalse(unavailable.isNonRetryable(), "broker failure remains retryable");
        assertEquals(400, rejected.statusCode(), "ingest status is retained");
    }

    private static void testFalseThenTrueHitLimit() {
        Protocol.ProbeDefinition probe = snapshotProbe(
                "prb_condition", 1, new Protocol.Condition("requestRole", "eq", "follower"));
        EventBuffer events = new EventBuffer(10);
        HitProcessor processor = new HitProcessor(
                SafeSerializer.Config.defaults(), events, new AggregationStore());
        EmittedSlots slots = new EmittedSlots(probe.hitLimit());
        AtomicInteger completed = new AtomicInteger();

        processor.process(
                new RawHit(probe, Map.of("requestRole", "leader"), List.of()),
                slots,
                completed::incrementAndGet);
        assertEquals(0, slots.claimed(), "false condition does not consume hit limit");
        assertEquals(0, events.drain().size(), "false condition emits nothing");

        processor.process(
                new RawHit(probe, Map.of("requestRole", "follower"), List.of()),
                slots,
                completed::incrementAndGet);
        assertEquals(1, slots.claimed(), "matching condition consumes one slot");
        assertEquals(1, completed.get(), "matching limit retires once");
        assertEquals(1, events.drain().size(), "matching condition emits an event");
    }

    private static void testConcurrentMatchingSlots() throws InterruptedException {
        int limit = 37;
        Protocol.ProbeDefinition probe = snapshotProbe(
                "prb_concurrent", limit, new Protocol.Condition("requestRole", "eq", "follower"));
        EventBuffer events = new EventBuffer(1_000);
        HitProcessor processor = new HitProcessor(
                SafeSerializer.Config.defaults(), events, new AggregationStore());
        EmittedSlots slots = new EmittedSlots(limit);
        AtomicInteger completed = new AtomicInteger();
        RawHit matchingHit = new RawHit(
                probe, Map.of("requestRole", "follower"), List.of());

        int workers = 12;
        ExecutorService executor = Executors.newFixedThreadPool(workers);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(workers);
        for (int worker = 0; worker < workers; worker++) {
            executor.execute(() -> {
                try {
                    start.await();
                    for (int attempt = 0; attempt < 50; attempt++) {
                        processor.process(matchingHit, slots, completed::incrementAndGet);
                    }
                } catch (InterruptedException exception) {
                    Thread.currentThread().interrupt();
                } finally {
                    done.countDown();
                }
            });
        }
        start.countDown();
        assertTrue(done.await(5, TimeUnit.SECONDS), "concurrent slot test completed");
        executor.shutdownNow();

        assertEquals(limit, slots.claimed(), "concurrent matches cannot exceed hit limit");
        assertEquals(limit, events.drain().size(), "concurrent emitted events are capped");
        assertEquals(1, completed.get(), "concurrent limit callback runs once");
    }

    private static void testStackLineFiltering() {
        Protocol.ProbeDefinition probe = snapshotProbe("prb_stack", 1, null);
        EventBuffer events = new EventBuffer(10);
        HitProcessor processor = new HitProcessor(
                SafeSerializer.Config.defaults(), events, new AggregationStore());
        processor.process(
                new RawHit(
                        probe,
                        Map.of("value", 1L),
                        List.of(
                                new RawStackFrame("unknown", "Unknown.java", -1),
                                new RawStackFrame("native", "Native.java", 0),
                                new RawStackFrame("valid", "InventoryService.java", 336))),
                new EmittedSlots(1),
                () -> {});

        List<Map<String, Object>> emitted = events.drain();
        assertEquals(1, emitted.size(), "snapshot event emitted");
        Object rawStack = emitted.get(0).get("stack");
        assertTrue(rawStack instanceof List<?>, "snapshot stack is an array");
        List<?> stack = (List<?>) rawStack;
        assertEquals(1, stack.size(), "non-positive stack lines are omitted");
        Map<String, Object> frame = Json.stringMap((Map<?, ?>) stack.get(0));
        assertEquals(336, frame.get("line"), "positive stack line is retained");
        assertFalse(frame.containsKey("variables"), "legacy stack frame omits variables");
    }

    private static void testStackLocals() {
        Protocol.ProbeDefinition legacy =
                Protocol.parseProbe(probeObject("prb_stack_legacy", "snapshot"));
        List<RawStackFrame> rawFrames = List.of(
                new RawStackFrame(
                        "first",
                        "InventoryService.java",
                        10,
                        Map.of("visible", 7L, "password", "must-not-escape")),
                new RawStackFrame("second", "InventoryService.java", 20, null),
                new RawStackFrame("third", "InventoryService.java", 30, Map.of("value", 3L)),
                new RawStackFrame("fourth", "InventoryService.java", 40, Map.of("value", 4L)),
                new RawStackFrame("fifth", "InventoryService.java", 50, Map.of("value", 5L)));

        List<?> legacyStack = emitSnapshotStack(legacy, rawFrames);
        assertEquals(5, legacyStack.size(), "disabled stack locals preserve full location stack");
        for (Object rawFrame : legacyStack) {
            Map<String, Object> frame = Json.stringMap((Map<?, ?>) rawFrame);
            assertFalse(frame.containsKey("variables"), "disabled frame locals remain omitted");
        }

        Map<String, Object> enabledObject = probeObject("prb_stack_enabled", "snapshot");
        enabledObject.put("includeStackLocals", true);
        enabledObject.put("stackFrameLimit", 2L);
        Protocol.ProbeDefinition enabled = Protocol.parseProbe(enabledObject);
        List<?> stack = emitSnapshotStack(enabled, rawFrames);
        assertEquals(2, stack.size(), "enabled stack locals obey per-probe frame limit");

        Map<String, Object> first = Json.stringMap((Map<?, ?>) stack.get(0));
        Map<String, Object> firstVariables =
                Json.stringMap((Map<?, ?>) first.get("variables"));
        assertEquals("obj", firstVariables.get("t"), "frame locals serialize as an object node");
        Map<String, Object> firstChildren =
                Json.stringMap((Map<?, ?>) firstVariables.get("c"));
        assertEquals(
                7L,
                Json.stringMap((Map<?, ?>) firstChildren.get("visible")).get("v"),
                "frame local value is serialized");
        assertEquals(
                "redacted",
                Json.stringMap((Map<?, ?>) firstChildren.get("password")).get("t"),
                "frame local key uses existing redaction");

        Map<String, Object> second = Json.stringMap((Map<?, ?>) stack.get(1));
        Map<String, Object> secondVariables =
                Json.stringMap((Map<?, ?>) second.get("variables"));
        assertEquals("obj", secondVariables.get("t"), "unavailable locals emit an empty object");
        assertEquals(
                Map.of(),
                secondVariables.get("c"),
                "unavailable locals do not break or fabricate frame values");
    }

    private static void testAbsentStackLocalInfo() {
        StackFrame absentInfo = stackFrameThrowing(new AbsentInformationException());
        StackFrame staleFrame = stackFrameThrowing(new IllegalStateException("stale frame"));
        assertEquals(
                null,
                JdiStackCapture.readLocalsOrNull(
                        absentInfo, SafeSerializer.Config.defaults()),
                "absent variable debug info is isolated to its frame");
        assertEquals(
                null,
                JdiStackCapture.readLocalsOrNull(
                        staleFrame, SafeSerializer.Config.defaults()),
                "frame read failures are isolated to their frame");
    }

    private static void testStackLocalReadBound() throws AbsentInformationException {
        List<LocalVariable> visible = List.of(
                localVariable("one"),
                localVariable("two"),
                localVariable("three"),
                localVariable("four"));
        AtomicInteger requested = new AtomicInteger();
        StackFrame frame = (StackFrame) Proxy.newProxyInstance(
                StackFrame.class.getClassLoader(),
                new Class<?>[] {StackFrame.class},
                (proxy, method, arguments) -> switch (method.getName()) {
                    case "visibleVariables" -> visible;
                    case "getValues" -> {
                        requested.set(((List<?>) arguments[0]).size());
                        yield Map.of();
                    }
                    default -> throw new UnsupportedOperationException(method.getName());
                });
        SafeSerializer.Config config =
                SafeSerializer.Config.fromJson(Map.of("maxProps", 2L));

        Map<String, Object> locals = JdiStackCapture.readLocals(frame, config);

        assertEquals(2, requested.get(), "JDI reads only the configured local limit");
        assertEquals(2, locals.size(), "bounded JDI locals preserve selected names");
    }

    private static Protocol.ProbeDefinition snapshotProbe(
            String id, int hitLimit, Protocol.Condition condition) {
        return new Protocol.ProbeDefinition(
                id,
                "inventory-service",
                Protocol.ProbeType.SNAPSHOT,
                "InventoryService.java",
                336,
                condition,
                null,
                List.of(),
                List.of(),
                false,
                3,
                null,
                Protocol.LogLevel.INFO,
                List.of(),
                null,
                null,
                hitLimit,
                1_800,
                1,
                "test");
    }

    private static List<?> emitSnapshotStack(
            Protocol.ProbeDefinition probe,
            List<RawStackFrame> stack) {
        EventBuffer events = new EventBuffer(10);
        new HitProcessor(
                        SafeSerializer.Config.defaults(), events, new AggregationStore())
                .process(
                        new RawHit(probe, Map.of("value", 1L), stack),
                        new EmittedSlots(1),
                        () -> {});
        return (List<?>) events.drain().get(0).get("stack");
    }

    private static StackFrame stackFrameThrowing(Exception exception) {
        return (StackFrame) Proxy.newProxyInstance(
                StackFrame.class.getClassLoader(),
                new Class<?>[] {StackFrame.class},
                (proxy, method, arguments) -> {
                    if ("visibleVariables".equals(method.getName())) {
                        throw exception;
                    }
                    throw new UnsupportedOperationException(method.getName());
                });
    }

    private static LocalVariable localVariable(String name) {
        return (LocalVariable) Proxy.newProxyInstance(
                LocalVariable.class.getClassLoader(),
                new Class<?>[] {LocalVariable.class},
                (proxy, method, arguments) -> {
                    if ("name".equals(method.getName())) {
                        return name;
                    }
                    throw new UnsupportedOperationException(method.getName());
                });
    }

    private static Map<String, Object> probeObject(String id, String type) {
        LinkedHashMap<String, Object> probe = new LinkedHashMap<>();
        probe.put("id", id);
        probe.put("serviceId", "inventory-service");
        probe.put("type", type);
        probe.put("file", "InventoryService.java");
        probe.put("line", 336L);
        probe.put("hitLimit", 1L);
        probe.put("ttlSeconds", 1_800L);
        probe.put("version", 1L);
        probe.put("createdBy", "test");
        return probe;
    }

    private static Map<String, Object> compiledObject(String source, Object ast) {
        return Map.of("source", source, "ast", ast);
    }

    private static Map<String, Object> literalObject(Object value) {
        LinkedHashMap<String, Object> literal = new LinkedHashMap<>();
        literal.put("type", "literal");
        literal.put("value", value);
        return literal;
    }

    private static Map<String, Object> referenceObject(Object... path) {
        return Map.of("type", "reference", "path", List.of(path));
    }

    private static Map<String, Object> binaryObject(String operator, Object left, Object right) {
        return Map.of(
                "type", "binary",
                "operator", operator,
                "left", left,
                "right", right);
    }

    private static SafeExpression.Literal literal(Object value) {
        return new SafeExpression.Literal(value);
    }

    private static SafeExpression.Reference reference(Object... path) {
        return new SafeExpression.Reference(List.of(path));
    }

    private static SafeExpression.Unary unary(String operator, SafeExpression.Node operand) {
        return new SafeExpression.Unary(operator, operand);
    }

    private static SafeExpression.Binary binary(
            String operator,
            SafeExpression.Node left,
            SafeExpression.Node right) {
        return new SafeExpression.Binary(operator, left, right);
    }

    private static void assertExpressionEquals(
            Object expected,
            SafeExpression.Node ast,
            Map<String, Object> variables,
            String message) {
        SafeExpression.Result result = SafeExpression.evaluate(
                new SafeExpression.Compiled(message, ast),
                variables,
                SafeSerializer.Config.defaults());
        assertTrue(result.ok(), message + " evaluates successfully");
        assertDeepEquals(expected, result.value(), message);
    }

    private static void assertExpressionError(
            String expected,
            SafeExpression.Node ast,
            Map<String, Object> variables,
            String message) {
        SafeExpression.Result result = SafeExpression.evaluate(
                new SafeExpression.Compiled(message, ast),
                variables,
                SafeSerializer.Config.defaults());
        assertFalse(result.ok(), message + " fails");
        assertEquals(expected, result.error(), message + " error");
    }

    private static Object wideTree(int depth) {
        if (depth == 0) {
            return literalObject(true);
        }
        return binaryObject("and", wideTree(depth - 1), wideTree(depth - 1));
    }

    private static Path expressionFixturePath() {
        for (Path candidate : List.of(
                Path.of("../../spec/fixtures/expressions/evaluator.json"),
                Path.of("spec/fixtures/expressions/evaluator.json"),
                Path.of("../spec/fixtures/expressions/evaluator.json"))) {
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        throw new AssertionError("expression evaluator fixture not found");
    }

    private static Path fixtureDirectory() {
        for (Path candidate : List.of(
                Path.of("../../spec/fixtures/serializer"),
                Path.of("spec/fixtures/serializer"),
                Path.of("../spec/fixtures/serializer"))) {
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
        }
        throw new AssertionError("serializer fixture directory not found");
    }

    private static void assertDeepEquals(Object expected, Object actual, String message) {
        if (!deepEquals(expected, actual)) {
            throw new AssertionError(message + "\nexpected: " + Json.stringify(expected)
                    + "\nactual:   " + Json.stringify(actual));
        }
        assertions++;
    }

    private static boolean deepEquals(Object expected, Object actual) {
        if (expected instanceof Number left && actual instanceof Number right) {
            return new BigDecimal(left.toString()).compareTo(new BigDecimal(right.toString())) == 0;
        }
        if (expected instanceof Map<?, ?> left && actual instanceof Map<?, ?> right) {
            if (!left.keySet().equals(right.keySet())) {
                return false;
            }
            for (Object key : left.keySet()) {
                if (!deepEquals(left.get(key), right.get(key))) {
                    return false;
                }
            }
            return true;
        }
        if (expected instanceof List<?> left && actual instanceof List<?> right) {
            if (left.size() != right.size()) {
                return false;
            }
            for (int index = 0; index < left.size(); index++) {
                if (!deepEquals(left.get(index), right.get(index))) {
                    return false;
                }
            }
            return true;
        }
        return java.util.Objects.equals(expected, actual);
    }

    private static void assertTrue(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
        assertions++;
    }

    private static void assertFalse(boolean condition, String message) {
        assertTrue(!condition, message);
    }

    private static void assertEquals(Object expected, Object actual, String message) {
        if (!java.util.Objects.equals(expected, actual)) {
            throw new AssertionError(message + ": expected " + expected + ", got " + actual);
        }
        assertions++;
    }

    private static void assertThrows(Runnable action, String message) {
        try {
            action.run();
        } catch (RuntimeException expected) {
            assertions++;
            return;
        }
        throw new AssertionError(message);
    }

    private static final class MutableNanoClock implements LongSupplier {
        private long now;

        @Override
        public long getAsLong() {
            return now;
        }

        private void advance(long nanos) {
            now += nanos;
        }
    }

    private static final class FixtureMaterializer {
        private final Map<String, Object> identities = new LinkedHashMap<>();

        private Object materialize(Object value) {
            if (value instanceof List<?> list) {
                ArrayList<Object> result = new ArrayList<>(list.size());
                for (Object item : list) {
                    result.add(materialize(item));
                }
                return result;
            }
            if (!(value instanceof Map<?, ?> rawMap)) {
                return value;
            }
            Map<String, Object> map = Json.stringMap(rawMap);
            Object fixtureTag = map.get("$fixture");
            if ("function".equals(fixtureTag)) {
                return RawFunction.INSTANCE;
            }
            if ("ref".equals(fixtureTag)) {
                Object reference = identities.get(map.get("id"));
                if (reference == null) {
                    throw new AssertionError("unknown fixture reference: " + map.get("id"));
                }
                return reference;
            }
            if ("object".equals(fixtureTag)) {
                LinkedHashMap<String, Object> object = new LinkedHashMap<>();
                register(map, object);
                Object rawValue = map.get("value");
                if (!(rawValue instanceof Map<?, ?> source)) {
                    throw new AssertionError("object fixture value must be an object");
                }
                for (Map.Entry<?, ?> entry : source.entrySet()) {
                    object.put((String) entry.getKey(), materialize(entry.getValue()));
                }
                return object;
            }
            if ("array".equals(fixtureTag)) {
                ArrayList<Object> array = new ArrayList<>();
                register(map, array);
                Object rawValue = map.get("value");
                if (!(rawValue instanceof List<?> source)) {
                    throw new AssertionError("array fixture value must be an array");
                }
                for (Object item : source) {
                    array.add(materialize(item));
                }
                return array;
            }

            LinkedHashMap<String, Object> object = new LinkedHashMap<>();
            for (Map.Entry<String, Object> entry : map.entrySet()) {
                object.put(entry.getKey(), materialize(entry.getValue()));
            }
            return object;
        }

        private void register(Map<String, Object> map, Object value) {
            Object id = map.get("id");
            if (!(id instanceof String text) || identities.putIfAbsent(text, value) != null) {
                throw new AssertionError("fixture identity must be a unique string");
            }
        }
    }
}
