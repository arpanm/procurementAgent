package ai.procurecopilot.backend.session;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * In-memory, append-only session event log (PROCURE_COPILOT_PLAN.md §3.6.4). Each session is an ordered
 * event log; live viewers subscribe over SSE (§3.6.5). Thread-safe: per-session appends are serialized so
 * {@code seq} is monotonic and SSE delivery preserves order.
 *
 * <p><b>Durability &amp; scope (honest status):</b> this is the BACKEND'S working copy, not a durable
 * system of record. Per the local-first design (§3.6), the DEVICE is the source of truth — it owns live
 * state and re-hydrates/continues after a backend restart, and its outbox deliberately tolerates a 404
 * for a session the backend no longer has ({@code BackendHttpError.isClientError}). Consequences:
 * <ul>
 *   <li>events are lost on backend restart (acceptable: the device holds the authoritative log);
 *   <li>it is single-instance — a multi-replica deployment must either use sticky sessions or move this
 *       to a shared store (Postgres/Redis) with shared SSE pub/sub. Deferred as a scale-up item.
 * </ul>
 */
@Service
public class SessionStore {

    private static final Logger log = LoggerFactory.getLogger(SessionStore.class);

    /** SSE connections held open for ~30 min before the client must reconnect. */
    private static final long SSE_TIMEOUT_MS = 30 * 60 * 1000L;

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /** Create a fresh session and return its id. */
    public String createSession() {
        String id = UUID.randomUUID().toString();
        sessions.put(id, new Session());
        return id;
    }

    public boolean exists(String sessionId) {
        return sessionId != null && sessions.containsKey(sessionId);
    }

    /** Append an event, assigning the next monotonic seq. */
    public SessionEvent append(String sessionId, String type, Map<String, Object> payload) {
        return append(sessionId, type, payload, null);
    }

    /**
     * Append an event idempotently. When {@code clientEventId} is non-blank and already seen for this
     * session, the previously stored event is returned and nothing is appended (safe retry from the
     * device's local outbox, §3.6.4).
     */
    public SessionEvent append(
            String sessionId, String type, Map<String, Object> payload, String clientEventId) {
        Session session = require(sessionId);
        boolean dedupeKey = clientEventId != null && !clientEventId.isBlank();
        synchronized (session.lock) {
            if (dedupeKey) {
                SessionEvent prior = session.dedupe.get(clientEventId);
                if (prior != null) {
                    return prior;
                }
            }
            long seq = session.seq.getAndIncrement();
            Map<String, Object> body = payload == null
                    ? Map.of()
                    : java.util.Collections.unmodifiableMap(new LinkedHashMap<>(payload));
            SessionEvent event = new SessionEvent(
                    seq, type == null ? "unknown" : type, body, Instant.now());
            session.events.add(event);
            if (dedupeKey) {
                session.dedupe.put(clientEventId, event);
            }
            // Broadcast inside the lock so per-session SSE delivery is strictly ordered by seq.
            broadcast(session, event);
            return event;
        }
    }

    /** The full ordered event log for a session. */
    public List<SessionEvent> events(String sessionId) {
        return new ArrayList<>(require(sessionId).events);
    }

    /**
     * A latest-state projection of the log: every event's payload folded in (later overrides earlier),
     * plus log metadata. This is the working state the UX/resume path binds to.
     */
    public Map<String, Object> projection(String sessionId) {
        Session session = require(sessionId);
        Map<String, Object> projection = new LinkedHashMap<>();
        List<SessionEvent> snapshot = new ArrayList<>(session.events);
        for (SessionEvent event : snapshot) {
            if (event.payload() != null) {
                projection.putAll(event.payload());
            }
        }
        projection.put("eventCount", snapshot.size());
        if (!snapshot.isEmpty()) {
            SessionEvent last = snapshot.get(snapshot.size() - 1);
            projection.put("lastSeq", last.seq());
            projection.put("lastType", last.type());
        }
        return projection;
    }

    /** Subscribe to live appends for a session via SSE; future events are pushed in order. */
    public SseEmitter subscribe(String sessionId) {
        Session session = require(sessionId);
        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        session.emitters.add(emitter);
        emitter.onCompletion(() -> session.emitters.remove(emitter));
        emitter.onTimeout(() -> {
            session.emitters.remove(emitter);
            emitter.complete();
        });
        emitter.onError(e -> session.emitters.remove(emitter));
        try {
            // Flush an initial comment so the response headers commit immediately (otherwise a client
            // blocks until the first real event); also acts as a connection heartbeat.
            emitter.send(SseEmitter.event().comment("subscribed"));
        } catch (Exception e) {
            session.emitters.remove(emitter);
        }
        return emitter;
    }

    private void broadcast(Session session, SessionEvent event) {
        for (SseEmitter emitter : session.emitters) {
            try {
                emitter.send(SseEmitter.event()
                        .id(Long.toString(event.seq()))
                        .name(event.type())
                        .data(event));
            } catch (Exception e) {
                // Dead/slow client: drop it. onError/onCompletion also clean up.
                log.debug("Dropping SSE emitter after send failure: {}", e.toString());
                session.emitters.remove(emitter);
            }
        }
    }

    private Session require(String sessionId) {
        Session session = sessionId == null ? null : sessions.get(sessionId);
        if (session == null) {
            throw new NoSuchElementException("Unknown session: " + sessionId);
        }
        return session;
    }

    /** Per-session state. {@code lock} serializes appends; the lists are independently thread-safe. */
    private static final class Session {
        final List<SessionEvent> events = new CopyOnWriteArrayList<>();
        final AtomicLong seq = new AtomicLong(0);
        final Map<String, SessionEvent> dedupe = new ConcurrentHashMap<>();
        final List<SseEmitter> emitters = new CopyOnWriteArrayList<>();
        final Object lock = new Object();
    }
}
