package io.liveprobe.bridge;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Sends a batch to the broker, narrowing a rejection to the events that caused it.
 *
 * <p>Ingest validates the whole request body, so a single malformed event returns HTTP 400 for the
 * entire batch without naming the offender. Discarding the batch therefore discards every valid
 * event alongside the bad one — including probe status transitions, which is how a probe that armed
 * correctly can end up looking as though it never armed at all. Halving and retrying isolates the
 * offender instead.
 *
 * <p>A 400 caused by a field outside {@code events} (service id, agent status) fails every subset
 * equally, which is what the split budget bounds. The budget is spent across the whole retry tree
 * rather than per branch: a per-branch depth cap would never fire, since bisecting N events only
 * ever recurses log2(N) deep. The Node and Python agents use the same bound with the same meaning.
 */
final class IngestIsolation {
    /**
     * How many times one flush may halve a rejected batch. Isolating a single bad event out of a
     * batch of N costs about log2(N) splits, so this covers batches up to 256 events. A batch that
     * is mostly poison exhausts it and gives up one level early, dropping a small sub-batch rather
     * than letting a 400 no subset can satisfy turn every flush into a request storm.
     */
    static final int MAX_INGEST_SPLITS = 8;

    /** Sends one batch, throwing exactly as {@link BrokerClient#ingest} does. */
    interface Sender {
        void send(List<Map<String, Object>> batch) throws IOException, InterruptedException;
    }

    /** What became of the events in one flush. */
    static final class Result {
        /** Events the broker refused. Retrying them would fail identically. */
        final List<Map<String, Object>> rejected = new ArrayList<>();
        /** Events undelivered for a transient reason, in their original order. */
        final List<Map<String, Object>> deferred = new ArrayList<>();
        /** The last failure seen, for the caller to report. Null when everything landed. */
        IOException lastError;
    }

    private IngestIsolation() {}

    static Result send(List<Map<String, Object>> events, Sender sender)
            throws InterruptedException {
        Result result = new Result();
        int[] budget = {MAX_INGEST_SPLITS};
        isolate(events, sender, budget, result);
        return result;
    }

    private static void isolate(
            List<Map<String, Object>> events, Sender sender, int[] budget, Result into)
            throws InterruptedException {
        try {
            sender.send(events);
            return;
        } catch (BrokerIngestException exception) {
            into.lastError = exception;
            if (!exception.isNonRetryable()) {
                into.deferred.addAll(events);
                return;
            }
            if (events.size() <= 1 || budget[0] <= 0) {
                into.rejected.addAll(events);
                return;
            }
        } catch (IOException exception) {
            // A transient failure says nothing about which event is bad, so there is nothing to
            // isolate: one attempt, then retry the whole batch on the next flush.
            into.lastError = exception;
            into.deferred.addAll(events);
            return;
        } catch (RuntimeException exception) {
            // Deferred rather than rethrown: part of the tree may already have been delivered, and
            // unwinding would hand the caller a batch it could only requeue whole and duplicate.
            into.lastError = new IOException(exception.toString());
            into.deferred.addAll(events);
            return;
        }

        budget[0] -= 1;
        int middle = (events.size() + 1) / 2;
        isolate(new ArrayList<>(events.subList(0, middle)), sender, budget, into);
        isolate(new ArrayList<>(events.subList(middle, events.size())), sender, budget, into);
    }
}
