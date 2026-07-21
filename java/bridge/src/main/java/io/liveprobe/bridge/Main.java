package io.liveprobe.bridge;

import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.BooleanValue;
import com.sun.jdi.Bootstrap;
import com.sun.jdi.ByteValue;
import com.sun.jdi.CharValue;
import com.sun.jdi.DoubleValue;
import com.sun.jdi.Field;
import com.sun.jdi.FloatValue;
import com.sun.jdi.IncompatibleThreadStateException;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.Location;
import com.sun.jdi.LongValue;
import com.sun.jdi.ObjectCollectedException;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.PrimitiveValue;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.ShortValue;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.connect.IllegalConnectorArgumentsException;
import com.sun.jdi.event.BreakpointEvent;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.ClassPrepareRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;

import java.io.IOException;
import java.net.URI;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Java 17 JDI sidecar entry point. */
public final class Main {
    private Main() {}

    public static void main(String[] args) throws Exception {
        BridgeConfig config;
        try {
            config = BridgeConfig.parse(args);
        } catch (IllegalArgumentException exception) {
            System.err.println("liveprobe-bridge: " + exception.getMessage());
            printUsage();
            System.exit(2);
            return;
        }
        if (config.help()) {
            printUsage();
            return;
        }

        VirtualMachine virtualMachine = JdiAttacher.attach(config.attach());
        BridgeAgent agent;
        try {
            agent = new BridgeAgent(config, virtualMachine);
        } catch (RuntimeException exception) {
            virtualMachine.dispose();
            throw exception;
        }
        Thread shutdownHook = new Thread(agent::close, "liveprobe-shutdown");
        Runtime.getRuntime().addShutdownHook(shutdownHook);
        try {
            agent.start();
            agent.awaitTermination();
        } finally {
            agent.close();
            try {
                Runtime.getRuntime().removeShutdownHook(shutdownHook);
            } catch (IllegalStateException ignored) {
                // JVM shutdown is already in progress.
            }
        }
    }

    private static void printUsage() {
        System.err.println("""
                Usage: java -jar liveprobe-bridge.jar \\
                  --service <service-id> --attach <host:port> --broker <http(s)://broker> --commit <sha>

                Optional: --hits-per-second <n>, --redact-key <pattern>, --redact-value <literal>
                The target must expose JDWP (prefer a localhost bind) and include -g debug information.
                """);
    }
}

record AttachAddress(String host, int port) {
    AttachAddress {
        if (host == null || host.isBlank() || port <= 0 || port > 65_535) {
            throw new IllegalArgumentException("attach must be host:port with a valid port");
        }
    }
}

record BridgeConfig(
        String serviceId,
        AttachAddress attach,
        URI brokerUri,
        String apiKey,
        String commitSha,
        String commitSource,
        int hitsPerSecond,
        SafeSerializer.Config serializerConfig,
        boolean help) {
    static BridgeConfig parse(String[] args) {
        String service = null;
        AttachAddress attach = null;
        URI broker = null;
        String commit = null;
        String commitSource = "config";
        int hitsPerSecond = 10;
        ArrayList<String> redactKeys = new ArrayList<>();
        ArrayList<String> redactValues = new ArrayList<>();
        boolean help = false;

        for (int index = 0; index < args.length; index++) {
            String flag = args[index];
            if ("--help".equals(flag) || "-h".equals(flag)) {
                help = true;
                continue;
            }
            if (index + 1 >= args.length) {
                throw new IllegalArgumentException("missing value for " + flag);
            }
            String value = args[++index];
            switch (flag) {
                case "--service" -> service = value;
                case "--attach" -> attach = parseAttach(value);
                case "--broker" -> {
                    try {
                        broker = URI.create(value);
                    } catch (IllegalArgumentException exception) {
                        throw new IllegalArgumentException("broker must be a valid URL");
                    }
                }
                case "--commit" -> commit = value;
                case "--hits-per-second" -> hitsPerSecond = positiveInt(value, flag);
                case "--redact-key" -> redactKeys.add(value);
                case "--redact-value" -> redactValues.add(value);
                default -> throw new IllegalArgumentException("unknown argument: " + flag);
            }
        }

        if (help) {
            return new BridgeConfig(
                    "", new AttachAddress("localhost", 1), URI.create("http://localhost"),
                    "", "abcdef1", "config", hitsPerSecond, SafeSerializer.Config.defaults(), true);
        }
        if (service == null || service.isBlank()) {
            throw new IllegalArgumentException("--service is required");
        }
        if (attach == null) {
            throw new IllegalArgumentException("--attach is required");
        }
        if (broker == null) {
            throw new IllegalArgumentException("--broker is required");
        }
        if (commit == null || commit.isBlank()) {
            commit = env("LIVEPROBE_COMMIT_SHA");
            if (commit == null || commit.isBlank()) {
                commit = env("GIT_COMMIT");
            }
            commitSource = "env";
        }
        if (commit == null || commit.isBlank() || "unknown".equalsIgnoreCase(commit)) {
            throw new IllegalArgumentException("--commit or LIVEPROBE_COMMIT_SHA/GIT_COMMIT is required");
        }
        if (!commit.matches("(?i)^[0-9a-f]{7,64}$")) {
            throw new IllegalArgumentException("--commit must be a 7-64 character hexadecimal Git object ID");
        }
        SafeSerializer.Config serializerConfig = new SafeSerializer.Config(
                3, 3, 50, 1024, 8, redactKeys, redactValues);
        return new BridgeConfig(
                service,
                attach,
                broker,
                env("LIVEPROBE_API_KEY"),
                commit.toLowerCase(),
                commitSource,
                hitsPerSecond,
                serializerConfig,
                false);
    }

    private static String env(String name) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static AttachAddress parseAttach(String value) {
        String host;
        String portText;
        if (value.startsWith("[")) {
            int closing = value.indexOf(']');
            if (closing <= 1 || closing + 2 > value.length() || value.charAt(closing + 1) != ':') {
                throw new IllegalArgumentException("--attach must be host:port");
            }
            host = value.substring(1, closing);
            portText = value.substring(closing + 2);
        } else {
            int separator = value.lastIndexOf(':');
            if (separator <= 0 || separator == value.length() - 1) {
                throw new IllegalArgumentException("--attach must be host:port");
            }
            host = value.substring(0, separator);
            portText = value.substring(separator + 1);
        }
        return new AttachAddress(host, positiveInt(portText, "--attach port"));
    }

    private static int positiveInt(String value, String name) {
        try {
            int parsed = Integer.parseInt(value);
            if (parsed <= 0) {
                throw new NumberFormatException();
            }
            return parsed;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(name + " must be a positive integer");
        }
    }
}

final class JdiAttacher {
    private JdiAttacher() {}

    static VirtualMachine attach(AttachAddress address)
            throws IOException, IllegalConnectorArgumentsException {
        AttachingConnector socketConnector = null;
        for (AttachingConnector connector : Bootstrap.virtualMachineManager().attachingConnectors()) {
            if ("com.sun.jdi.SocketAttach".equals(connector.name())) {
                socketConnector = connector;
                break;
            }
        }
        if (socketConnector == null) {
            throw new IllegalStateException("JDK SocketAttach connector is unavailable");
        }
        Map<String, Connector.Argument> arguments = socketConnector.defaultArguments();
        Connector.Argument hostname = arguments.get("hostname");
        Connector.Argument port = arguments.get("port");
        if (hostname == null || port == null) {
            throw new IllegalStateException("SocketAttach connector arguments are unavailable");
        }
        hostname.setValue(address.host());
        port.setValue(Integer.toString(address.port()));
        return socketConnector.attach(arguments);
    }
}

final class BridgeAgent implements AutoCloseable {
    private final BridgeConfig config;
    private final VirtualMachine virtualMachine;
    private final BrokerClient broker;
    private final EventBuffer eventBuffer = new EventBuffer(2_000);
    private final AggregationStore aggregations = new AggregationStore();
    private final ScheduledExecutorService networkExecutor =
            Executors.newSingleThreadScheduledExecutor(new NamedThreadFactory("liveprobe-network"));
    private final ScheduledExecutorService safetyExecutor =
            Executors.newSingleThreadScheduledExecutor(new NamedThreadFactory("liveprobe-safety"));
    private final ExecutorService processorExecutor =
            Executors.newSingleThreadExecutor(new NamedThreadFactory("liveprobe-processor"));
    private final AtomicBoolean closed = new AtomicBoolean();
    private final CountDownLatch terminated = new CountDownLatch(1);
    private final ProbeManager probeManager;
    private final HitProcessor hitProcessor;
    private final Thread eventThread;
    private volatile long brokerVersion;
    private volatile long lastAggregateFlushNanos;

    BridgeAgent(BridgeConfig config, VirtualMachine virtualMachine) {
        this.config = config;
        this.virtualMachine = virtualMachine;
        this.broker = new BrokerClient(
                config.brokerUri(),
                config.serviceId(),
                config.apiKey(),
                config.commitSha(),
                config.commitSource());
        this.probeManager = new ProbeManager(
                virtualMachine,
                new RateLimiter(config.hitsPerSecond()),
                config.serializerConfig(),
                eventBuffer,
                aggregations,
                safetyExecutor);
        this.hitProcessor = new HitProcessor(
                config.serializerConfig(), eventBuffer, aggregations);
        this.eventThread = new Thread(this::eventLoop, "liveprobe-jdi-events");
    }

    void start() {
        probeManager.installClassPrepareRequest();
        lastAggregateFlushNanos = System.nanoTime();
        eventThread.start();
        networkExecutor.scheduleWithFixedDelay(this::networkTick, 0, 1, TimeUnit.SECONDS);
        System.out.println("[liveprobe] JVM BRIDGE ATTACHED " + config.attach().host() + ":" + config.attach().port());
    }

    void awaitTermination() throws InterruptedException {
        terminated.await();
    }

    private void networkTick() {
        if (closed.get()) {
            return;
        }
        try {
            Protocol.PollResponse response = broker.poll(brokerVersion);
            if (!response.unchanged()) {
                ArrayList<Protocol.ProbeDefinition> serviceProbes = new ArrayList<>();
                for (Protocol.ProbeDefinition probe : response.probes()) {
                    if (config.serviceId().equals(probe.serviceId())) {
                        serviceProbes.add(probe);
                    }
                }
                probeManager.reconcile(serviceProbes);
            }
            brokerVersion = response.version();
        } catch (IOException | RuntimeException exception) {
            System.err.println("[liveprobe] broker poll failed: " + safeMessage(exception));
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            return;
        }

        long now = System.nanoTime();
        if (now - lastAggregateFlushNanos >= TimeUnit.SECONDS.toNanos(2)) {
            for (Map<String, Object> event : aggregations.drain()) {
                eventBuffer.add(event);
            }
            lastAggregateFlushNanos = now;
        }

        List<Map<String, Object>> batch = eventBuffer.drain();
        try {
            broker.ingest(probeManager.agentState(), probeManager.agentDetail(), batch);
        } catch (IOException | RuntimeException exception) {
            eventBuffer.restore(batch);
            System.err.println("[liveprobe] broker ingest failed: " + safeMessage(exception));
        } catch (InterruptedException exception) {
            eventBuffer.restore(batch);
            Thread.currentThread().interrupt();
        }
    }

    private void eventLoop() {
        try {
            while (!closed.get()) {
                EventSet eventSet = virtualMachine.eventQueue().remove();
                ArrayList<CaptureOutcome> outcomes = new ArrayList<>();
                ArrayList<ReferenceType> preparedTypes = new ArrayList<>();
                ArrayList<RuntimeException> captureErrors = new ArrayList<>();
                boolean disconnected = false;
                try {
                    for (Event event : eventSet) {
                        if (event instanceof BreakpointEvent breakpointEvent) {
                            try {
                                outcomes.add(probeManager.capture(breakpointEvent));
                            } catch (RuntimeException exception) {
                                captureErrors.add(exception);
                            }
                        } else if (event instanceof ClassPrepareEvent classPrepareEvent) {
                            preparedTypes.add(classPrepareEvent.referenceType());
                        } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
                            disconnected = true;
                        }
                    }
                } finally {
                    try {
                        eventSet.resume();
                    } catch (VMDisconnectedException ignored) {
                        disconnected = true;
                    }
                }

                for (RuntimeException captureError : captureErrors) {
                    System.err.println("[liveprobe] capture failed: " + safeMessage(captureError));
                }
                for (ReferenceType preparedType : preparedTypes) {
                    probeManager.onClassPrepared(preparedType);
                }
                for (CaptureOutcome outcome : outcomes) {
                    probeManager.afterResume(outcome, processorExecutor, hitProcessor);
                }
                if (disconnected) {
                    break;
                }
            }
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        } catch (VMDisconnectedException ignored) {
            // Target shutdown is a normal terminal condition.
        } finally {
            stop(false);
        }
    }

    @Override
    public void close() {
        stop(true);
    }

    private void stop(boolean disposeTargetConnection) {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        probeManager.close();
        networkExecutor.shutdownNow();
        safetyExecutor.shutdownNow();
        processorExecutor.shutdown();
        awaitExecutor(networkExecutor);
        awaitExecutor(processorExecutor);
        for (Map<String, Object> event : aggregations.drain()) {
            eventBuffer.add(event);
        }
        List<Map<String, Object>> finalBatch = eventBuffer.drain();
        try {
            broker.ingest(probeManager.agentState(), probeManager.agentDetail(), finalBatch);
        } catch (IOException | RuntimeException exception) {
            System.err.println("[liveprobe] final broker ingest failed: " + safeMessage(exception));
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
        }
        if (disposeTargetConnection) {
            try {
                virtualMachine.dispose();
            } catch (VMDisconnectedException ignored) {
                // The target has already exited.
            }
        }
        eventThread.interrupt();
        terminated.countDown();
    }

    private static void awaitExecutor(ExecutorService executor) {
        try {
            if (!executor.awaitTermination(2, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException exception) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private static String safeMessage(Throwable throwable) {
        String message = throwable.getMessage();
        return message == null || message.isBlank() ? throwable.getClass().getSimpleName() : message;
    }
}

final class ProbeManager implements AutoCloseable {
    private static final String PROBE_PROPERTY = "liveprobe.probe";

    private final VirtualMachine virtualMachine;
    private final EventRequestManager requestManager;
    private final RateLimiter rateLimiter;
    private final SafeSerializer.Config serializerConfig;
    private final EventBuffer eventBuffer;
    private final AggregationStore aggregations;
    private final ScheduledExecutorService safetyExecutor;
    private final LinkedHashMap<String, ManagedProbe> probes = new LinkedHashMap<>();
    private ClassPrepareRequest classPrepareRequest;
    private int suspendedRequests;

    ProbeManager(
            VirtualMachine virtualMachine,
            RateLimiter rateLimiter,
            SafeSerializer.Config serializerConfig,
            EventBuffer eventBuffer,
            AggregationStore aggregations,
            ScheduledExecutorService safetyExecutor) {
        this.virtualMachine = virtualMachine;
        this.requestManager = virtualMachine.eventRequestManager();
        this.rateLimiter = rateLimiter;
        this.serializerConfig = serializerConfig;
        this.eventBuffer = eventBuffer;
        this.aggregations = aggregations;
        this.safetyExecutor = safetyExecutor;
    }

    synchronized void installClassPrepareRequest() {
        classPrepareRequest = requestManager.createClassPrepareRequest();
        classPrepareRequest.setSuspendPolicy(EventRequest.SUSPEND_NONE);
        classPrepareRequest.enable();
    }

    synchronized void reconcile(List<Protocol.ProbeDefinition> definitions) {
        LinkedHashMap<String, Protocol.ProbeDefinition> desired = new LinkedHashMap<>();
        for (Protocol.ProbeDefinition definition : definitions) {
            desired.put(definition.id(), definition);
        }

        Iterator<Map.Entry<String, ManagedProbe>> existing = probes.entrySet().iterator();
        while (existing.hasNext()) {
            Map.Entry<String, ManagedProbe> entry = existing.next();
            Protocol.ProbeDefinition replacement = desired.get(entry.getKey());
            if (replacement == null || !replacement.equals(entry.getValue().definition)) {
                uninstall(entry.getValue());
                aggregations.remove(entry.getKey());
                existing.remove();
            }
        }

        for (Protocol.ProbeDefinition definition : definitions) {
            if (probes.containsKey(definition.id())) {
                continue;
            }
            ManagedProbe managed = new ManagedProbe(definition);
            probes.put(definition.id(), managed);
            int armed = 0;
            for (ReferenceType type : virtualMachine.allClasses()) {
                armed += armInType(managed, type);
            }
            if (armed == 0) {
                managed.lineErrorReported = true;
                eventBuffer.add(Protocol.statusEvent(
                        definition.id(), "error", "line-not-found; waiting for class prepare"));
                audit("PROBE WAITING", definition, "line not found in loaded classes");
            } else {
                reportArmed(managed);
            }
        }
    }

    synchronized void onClassPrepared(ReferenceType type) {
        for (ManagedProbe managed : probes.values()) {
            if (!managed.completed && armInType(managed, type) > 0) {
                reportArmed(managed);
            }
        }
    }

    synchronized CaptureOutcome capture(BreakpointEvent event) {
        Object property = event.request().getProperty(PROBE_PROPERTY);
        if (!(property instanceof ManagedProbe managed)
                || !managed.active
                || managed.completed
                || !probes.containsKey(managed.definition.id())) {
            return CaptureOutcome.ignored();
        }

        if (!rateLimiter.tryAcquire()) {
            BreakpointRequest request = (BreakpointRequest) event.request();
            if (managed.rateDisabled.add(request)) {
                request.disable();
                suspendedRequests++;
            }
            long waitNanos = rateLimiter.nanosUntilReset();
            return new CaptureOutcome.RateLimited(managed, request, waitNanos);
        }

        try {
            StackFrame frame = event.thread().frame(0);
            List<LocalVariable> visible = frame.visibleVariables();
            Map<LocalVariable, Value> values = frame.getValues(visible);
            LinkedHashMap<String, Object> variables = new LinkedHashMap<>();
            for (LocalVariable variable : visible) {
                variables.put(variable.name(), JdiValueReader.read(
                        values.get(variable), serializerConfig));
            }
            List<RawStackFrame> stack = managed.definition.type() == Protocol.ProbeType.SNAPSHOT
                    ? captureStack(event, serializerConfig.maxStackFrames())
                    : List.of();
            return new CaptureOutcome.Captured(
                    managed, new RawHit(managed.definition, variables, stack));
        } catch (AbsentInformationException exception) {
            return new CaptureOutcome.Failed(
                    managed, "local-variable-debug-info-unavailable");
        } catch (IncompatibleThreadStateException | IndexOutOfBoundsException exception) {
            return new CaptureOutcome.Failed(
                    managed, "event-thread-frame-unavailable");
        }
    }

    void afterResume(
            CaptureOutcome outcome,
            ExecutorService processorExecutor,
            HitProcessor hitProcessor) {
        if (outcome instanceof CaptureOutcome.Captured captured) {
            processorExecutor.execute(() -> hitProcessor.process(
                    captured.hit(),
                    captured.managed().emittedSlots,
                    () -> completeMatchingLimit(captured.managed())));
        } else if (outcome instanceof CaptureOutcome.Failed failed) {
            eventBuffer.add(Protocol.statusEvent(
                    failed.managed().definition.id(), "error", failed.detail()));
        } else if (outcome instanceof CaptureOutcome.RateLimited limited) {
            eventBuffer.add(Protocol.statusEvent(
                    limited.managed().definition.id(), "suspended", "hits-per-second limit"));
            long delay = Math.max(TimeUnit.MILLISECONDS.toNanos(1), limited.waitNanos());
            safetyExecutor.schedule(
                    () -> reenable(limited.managed(), limited.request()),
                    delay,
                    TimeUnit.NANOSECONDS);
        }
    }

    private synchronized void completeMatchingLimit(ManagedProbe managed) {
        if (!managed.active
                || managed.completed
                || probes.get(managed.definition.id()) != managed) {
            return;
        }
        managed.completed = true;
        disableAll(managed);
        retireCompleted(managed);
        eventBuffer.add(Protocol.statusEvent(
                managed.definition.id(), "hit-limit-reached", null));
        audit("PROBE HIT LIMIT", managed.definition, null);
    }

    private synchronized void retireCompleted(ManagedProbe managed) {
        for (BreakpointRequest request : managed.requests) {
            if (managed.rateDisabled.remove(request)) {
                suspendedRequests = Math.max(0, suspendedRequests - 1);
            }
            try {
                requestManager.deleteEventRequest(request);
            } catch (RuntimeException ignored) {
                // The request is already disabled; target disconnection is terminal.
            }
        }
        managed.requests.clear();
    }

    synchronized String agentState() {
        return suspendedRequests > 0 ? "red" : "green";
    }

    synchronized String agentDetail() {
        if (suspendedRequests > 0) {
            return suspendedRequests + " breakpoint request(s) rate-limited";
        }
        long armed = probes.values().stream().filter(probe -> !probe.completed).count();
        return armed + " probe(s) active";
    }

    private synchronized void reenable(ManagedProbe managed, BreakpointRequest request) {
        if (!managed.rateDisabled.remove(request)) {
            return;
        }
        suspendedRequests = Math.max(0, suspendedRequests - 1);
        if (managed.active && !managed.completed && managed.requests.contains(request)) {
            try {
                request.enable();
                eventBuffer.add(Protocol.statusEvent(
                        managed.definition.id(), "armed", "rate limit window reset"));
            } catch (RuntimeException ignored) {
                // Reconciliation may have deleted the request concurrently.
            }
        }
    }

    private int armInType(ManagedProbe managed, ReferenceType type) {
        if (!type.isPrepared() || !SourceResolver.matches(type, managed.definition.file())) {
            return 0;
        }
        List<Location> locations;
        try {
            locations = type.locationsOfLine(managed.definition.line());
        } catch (AbsentInformationException exception) {
            if (!managed.debugInfoErrorReported) {
                managed.debugInfoErrorReported = true;
                eventBuffer.add(Protocol.statusEvent(
                        managed.definition.id(), "error", "absent-debug-info; compile target with -g"));
            }
            return 0;
        }
        int added = 0;
        for (Location location : locations) {
            String key = SourceResolver.locationKey(location);
            if (!managed.locationKeys.add(key)) {
                continue;
            }
            BreakpointRequest request = requestManager.createBreakpointRequest(location);
            request.putProperty(PROBE_PROPERTY, managed);
            request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            request.enable();
            managed.requests.add(request);
            added++;
        }
        return added;
    }

    private void reportArmed(ManagedProbe managed) {
        if (!managed.armedReported) {
            managed.armedReported = true;
            eventBuffer.add(Protocol.statusEvent(
                    managed.definition.id(), "armed",
                    managed.definition.file() + ":" + managed.definition.line()));
            audit("PROBE ARMED", managed.definition, null);
        }
    }

    private void disableAll(ManagedProbe managed) {
        for (BreakpointRequest request : managed.requests) {
            try {
                request.disable();
            } catch (RuntimeException ignored) {
                // Request can disappear when the target unloads a class.
            }
        }
    }

    private void uninstall(ManagedProbe managed) {
        managed.active = false;
        disableAll(managed);
        for (BreakpointRequest request : managed.requests) {
            if (managed.rateDisabled.remove(request)) {
                suspendedRequests = Math.max(0, suspendedRequests - 1);
            }
            try {
                requestManager.deleteEventRequest(request);
            } catch (RuntimeException ignored) {
                // Target disconnection and class unloading are terminal for this request.
            }
        }
        managed.requests.clear();
    }

    @Override
    public synchronized void close() {
        for (ManagedProbe managed : probes.values()) {
            uninstall(managed);
        }
        probes.clear();
        if (classPrepareRequest != null) {
            try {
                classPrepareRequest.disable();
                requestManager.deleteEventRequest(classPrepareRequest);
            } catch (RuntimeException ignored) {
                // Target has already disconnected.
            }
        }
    }

    private static List<RawStackFrame> captureStack(BreakpointEvent event, int limit)
            throws IncompatibleThreadStateException {
        List<StackFrame> frames = event.thread().frames(0, Math.min(limit, event.thread().frameCount()));
        ArrayList<RawStackFrame> stack = new ArrayList<>(frames.size());
        for (StackFrame frame : frames) {
            Location location = frame.location();
            int line = location.lineNumber();
            if (line <= 0) {
                continue;
            }
            String source;
            try {
                source = location.sourcePath();
            } catch (AbsentInformationException exception) {
                source = location.declaringType().name();
            }
            stack.add(new RawStackFrame(location.method().name(), source, line));
        }
        return stack;
    }

    private static void audit(String action, Protocol.ProbeDefinition probe, String suffix) {
        String message = "[liveprobe] " + action + " " + probe.file() + ":" + probe.line()
                + " (" + probe.type().wireName() + ", by " + probe.createdBy() + ")";
        if (suffix != null) {
            message += " - " + suffix;
        }
        System.out.println(message);
    }
}

final class ManagedProbe {
    final Protocol.ProbeDefinition definition;
    final List<BreakpointRequest> requests = new ArrayList<>();
    final Set<String> locationKeys = new LinkedHashSet<>();
    final Set<BreakpointRequest> rateDisabled =
            Collections.newSetFromMap(new IdentityHashMap<>());
    final EmittedSlots emittedSlots;
    boolean active = true;
    boolean completed;
    boolean armedReported;
    boolean lineErrorReported;
    boolean debugInfoErrorReported;

    ManagedProbe(Protocol.ProbeDefinition definition) {
        this.definition = definition;
        this.emittedSlots = new EmittedSlots(definition.hitLimit());
    }
}

sealed interface CaptureOutcome {
    record Captured(ManagedProbe managed, RawHit hit) implements CaptureOutcome {}

    record RateLimited(ManagedProbe managed, BreakpointRequest request, long waitNanos)
            implements CaptureOutcome {}

    record Failed(ManagedProbe managed, String detail) implements CaptureOutcome {}

    record Ignored() implements CaptureOutcome {}

    static CaptureOutcome ignored() {
        return new Ignored();
    }
}

final class EmittedSlots {
    private final int limit;
    private final AtomicInteger claimed = new AtomicInteger();

    EmittedSlots(int limit) {
        if (limit <= 0) {
            throw new IllegalArgumentException("emitted slot limit must be positive");
        }
        this.limit = limit;
    }

    Claim tryClaim() {
        while (true) {
            int current = claimed.get();
            if (current >= limit) {
                return Claim.REJECTED;
            }
            int next = current + 1;
            if (claimed.compareAndSet(current, next)) {
                return new Claim(true, next == limit);
            }
        }
    }

    int claimed() {
        return claimed.get();
    }

    record Claim(boolean acquired, boolean limitReached) {
        private static final Claim REJECTED = new Claim(false, false);
    }
}

record RawHit(
        Protocol.ProbeDefinition definition,
        Map<String, Object> variables,
        List<RawStackFrame> stack) {}

record RawStackFrame(String function, String file, int line) {}

final class JdiValueReader {
    private JdiValueReader() {}

    static Object read(Value value, SafeSerializer.Config config) {
        return readValue(value, config, true);
    }

    private static Object readValue(Value value, SafeSerializer.Config config, boolean includeFields) {
        if (value == null) {
            return null;
        }
        if (value instanceof StringReference string) {
            return string.value();
        }
        if (value instanceof BooleanValue bool) {
            return bool.booleanValue();
        }
        if (value instanceof CharValue character) {
            return String.valueOf(character.charValue());
        }
        if (value instanceof ByteValue number) {
            return number.byteValue();
        }
        if (value instanceof ShortValue number) {
            return number.shortValue();
        }
        if (value instanceof IntegerValue number) {
            return number.intValue();
        }
        if (value instanceof LongValue number) {
            return number.longValue();
        }
        if (value instanceof FloatValue number) {
            return number.floatValue();
        }
        if (value instanceof DoubleValue number) {
            return number.doubleValue();
        }
        if (value instanceof PrimitiveValue) {
            return RawRedacted.INSTANCE;
        }
        if (value instanceof ObjectReference object) {
            String typeName = object.referenceType().name();
            if (!includeFields) {
                return new JdiObjectReference(typeName);
            }
            LinkedHashMap<String, Object> fields = new LinkedHashMap<>();
            try {
                for (Field field : object.referenceType().allFields()) {
                    if (field.isStatic() || field.isSynthetic()) {
                        continue;
                    }
                    String name = field.name();
                    if (fields.size() >= config.maxProps()) {
                        break;
                    }
                    if (fields.containsKey(name)) {
                        name = field.declaringType().name() + "." + name;
                    }
                    if (config.isRedactedKey(field.name())) {
                        fields.put(name, RawRedacted.INSTANCE);
                    } else {
                        fields.put(name, readValue(object.getValue(field), config, false));
                    }
                }
            } catch (ObjectCollectedException exception) {
                return new JdiObjectReference(typeName);
            }
            return new JdiObjectSummary(typeName, Collections.unmodifiableMap(fields));
        }
        return RawRedacted.INSTANCE;
    }
}

final class SourceResolver {
    private SourceResolver() {}

    static boolean matches(ReferenceType type, String requestedFile) {
        String requested = normalize(requestedFile);
        try {
            for (String sourcePath : type.sourcePaths(null)) {
                if (suffixMatches(normalize(sourcePath), requested)) {
                    return true;
                }
            }
        } catch (AbsentInformationException ignored) {
            // Fall through to source names.
        }
        try {
            for (String sourceName : type.sourceNames(null)) {
                if (suffixMatches(normalize(sourceName), requested)) {
                    return true;
                }
            }
        } catch (AbsentInformationException ignored) {
            return false;
        }
        return false;
    }

    static String locationKey(Location location) {
        return location.declaringType().name() + "#" + location.method().name() + "#" + location.codeIndex();
    }

    private static boolean suffixMatches(String known, String requested) {
        return known.equals(requested)
                || known.endsWith("/" + requested)
                || requested.endsWith("/" + known);
    }

    private static String normalize(String path) {
        String normalized = path.replace('\\', '/');
        while (normalized.startsWith("./")) {
            normalized = normalized.substring(2);
        }
        return normalized;
    }
}

final class HitProcessor {
    private final SafeSerializer.Config serializerConfig;
    private final EventBuffer eventBuffer;
    private final AggregationStore aggregations;

    HitProcessor(
            SafeSerializer.Config serializerConfig,
            EventBuffer eventBuffer,
            AggregationStore aggregations) {
        this.serializerConfig = serializerConfig;
        this.eventBuffer = eventBuffer;
        this.aggregations = aggregations;
    }

    void process(RawHit hit, EmittedSlots emittedSlots, Runnable onLimitReached) {
        Protocol.ProbeDefinition probe = hit.definition();
        if (!ConditionEvaluator.evaluate(hit.variables(), probe.condition())) {
            return;
        }
        EmittedSlots.Claim claim = emittedSlots.tryClaim();
        if (!claim.acquired()) {
            return;
        }
        if (claim.limitReached()) {
            onLimitReached.run();
        }
        switch (probe.type()) {
            case SNAPSHOT -> processSnapshot(hit);
            case LOG -> processLog(hit);
            case COUNTER -> aggregations.increment(probe.id());
            case METRIC -> processMetric(hit);
        }
    }

    private void processSnapshot(RawHit hit) {
        Protocol.ProbeDefinition probe = hit.definition();
        Map<String, Object> variables = SafeSerializer.serialize(hit.variables(), serializerConfig);
        LinkedHashMap<String, Object> watches = new LinkedHashMap<>();
        for (String path : probe.watchPaths()) {
            Object value = ConditionEvaluator.resolve(hit.variables(), path);
            watches.put(path, SafeSerializer.serializePath(path, value, serializerConfig));
        }
        ArrayList<Map<String, Object>> stack = new ArrayList<>();
        for (RawStackFrame rawFrame : hit.stack()) {
            if (rawFrame.line() <= 0) {
                continue;
            }
            LinkedHashMap<String, Object> frame = new LinkedHashMap<>();
            frame.put("fn", rawFrame.function());
            frame.put("file", rawFrame.file());
            frame.put("line", rawFrame.line());
            stack.add(frame);
        }
        eventBuffer.add(Protocol.snapshotEvent(probe.id(), variables, watches, stack));
    }

    private void processLog(RawHit hit) {
        Protocol.ProbeDefinition probe = hit.definition();
        String message = renderTemplate(probe.template(), hit.variables());
        eventBuffer.add(Protocol.logEvent(probe.id(), message));
        System.out.println("[liveprobe] " + message);
    }

    private void processMetric(RawHit hit) {
        Protocol.ProbeDefinition probe = hit.definition();
        if (ConditionEvaluator.pathIsRedacted(probe.metricPath(), serializerConfig)) {
            eventBuffer.add(Protocol.statusEvent(
                    probe.id(), "error", "metric path is redacted"));
            return;
        }
        Object value = ConditionEvaluator.resolve(hit.variables(), probe.metricPath());
        if (value instanceof Number number) {
            double sample = number.doubleValue();
            if (Double.isFinite(sample)) {
                aggregations.addMetric(probe.id(), sample);
            }
        }
    }

    private String renderTemplate(String template, Map<String, Object> variables) {
        StringBuilder rendered = new StringBuilder();
        int cursor = 0;
        while (cursor < template.length()) {
            int opening = template.indexOf("${", cursor);
            if (opening < 0) {
                rendered.append(template, cursor, template.length());
                break;
            }
            rendered.append(template, cursor, opening);
            int closing = template.indexOf('}', opening + 2);
            if (closing < 0) {
                rendered.append(template, opening, template.length());
                break;
            }
            String path = template.substring(opening + 2, closing);
            if (ConditionEvaluator.exists(variables, path)) {
                Object raw = ConditionEvaluator.resolve(variables, path);
                Map<String, Object> safe = SafeSerializer.serializePath(path, raw, serializerConfig);
                rendered.append(SafeSerializer.render(safe));
            } else {
                rendered.append("<missing>");
            }
            cursor = closing + 1;
        }
        return rendered.toString();
    }
}

final class AggregationStore {
    private final LinkedHashMap<String, Long> counters = new LinkedHashMap<>();
    private final LinkedHashMap<String, MetricAggregate> metrics = new LinkedHashMap<>();

    synchronized void increment(String probeId) {
        counters.merge(probeId, 1L, Long::sum);
    }

    synchronized void addMetric(String probeId, double value) {
        metrics.computeIfAbsent(probeId, ignored -> new MetricAggregate()).add(value);
    }

    synchronized List<Map<String, Object>> drain() {
        ArrayList<Map<String, Object>> events = new ArrayList<>();
        for (Map.Entry<String, Long> counter : counters.entrySet()) {
            if (counter.getValue() > 0) {
                events.add(Protocol.counterEvent(counter.getKey(), counter.getValue()));
            }
        }
        counters.clear();
        for (Map.Entry<String, MetricAggregate> metric : metrics.entrySet()) {
            MetricAggregate value = metric.getValue();
            if (value.count > 0) {
                events.add(Protocol.metricEvent(
                        metric.getKey(), value.count, value.sum, value.min, value.max, value.last));
            }
        }
        metrics.clear();
        return events;
    }

    synchronized void remove(String probeId) {
        counters.remove(probeId);
        metrics.remove(probeId);
    }

    private static final class MetricAggregate {
        private long count;
        private double sum;
        private double min = Double.POSITIVE_INFINITY;
        private double max = Double.NEGATIVE_INFINITY;
        private double last;

        private void add(double value) {
            double nextSum = sum + value;
            if (!Double.isFinite(nextSum)) {
                return;
            }
            count++;
            sum = nextSum;
            min = Math.min(min, value);
            max = Math.max(max, value);
            last = value;
        }
    }
}

final class EventBuffer {
    private final int capacity;
    private final ArrayDeque<Map<String, Object>> queue = new ArrayDeque<>();

    EventBuffer(int capacity) {
        this.capacity = capacity;
    }

    synchronized void add(Map<String, Object> event) {
        while (queue.size() >= capacity) {
            queue.removeFirst();
        }
        queue.addLast(event);
    }

    synchronized List<Map<String, Object>> drain() {
        ArrayList<Map<String, Object>> events = new ArrayList<>(queue);
        queue.clear();
        return events;
    }

    synchronized void restore(List<Map<String, Object>> events) {
        for (int index = events.size() - 1; index >= 0; index--) {
            queue.addFirst(events.get(index));
        }
        while (queue.size() > capacity) {
            queue.removeLast();
        }
    }
}

final class NamedThreadFactory implements java.util.concurrent.ThreadFactory {
    private final String name;

    NamedThreadFactory(String name) {
        this.name = Objects.requireNonNull(name);
    }

    @Override
    public Thread newThread(Runnable task) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        return thread;
    }
}
