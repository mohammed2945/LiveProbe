package io.liveprobe.bridge;

import java.io.IOException;
import java.math.BigDecimal;
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
        testIngestRetryClassification();
        testRateLimiter();
        testFalseThenTrueHitLimit();
        testConcurrentMatchingSlots();
        testStackLineFiltering();
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
                "inventory-service", "abcdef1234567890", "config",
                "green", "1 probe(s) active", List.of(status));
        Map<String, Object> decoded = Json.parseObject(Json.stringify(payload));
        assertEquals("jvm", decoded.get("sdk"), "JVM SDK mapping");
        assertEquals("inventory-service", decoded.get("serviceId"), "service mapping");
        assertEquals("abcdef1234567890", decoded.get("commitSha"), "commit SHA mapping");
        assertEquals("config", decoded.get("commitSource"), "commit source mapping");
        Object events = decoded.get("events");
        assertTrue(events instanceof List<?> list && list.size() == 1, "status event mapping");
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
                List.of(),
                null,
                null,
                hitLimit,
                1_800,
                1,
                "test");
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
