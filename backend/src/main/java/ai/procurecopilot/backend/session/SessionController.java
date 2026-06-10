package ai.procurecopilot.backend.session;

import java.util.Map;
import java.util.NoSuchElementException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Session/event-store endpoints (PROCURE_COPILOT_PLAN.md §3.6.4, §3.6.5, §3.6.7, Epic 0/5/6). The
 * backend is the durable system of record; the device appends events fire-and-forget and hydrates from
 * here on resume, while live viewers subscribe over SSE.
 */
@RestController
public class SessionController {

    private final SessionStore store;

    public SessionController(SessionStore store) {
        this.store = store;
    }

    @PostMapping("/sessions")
    public Map<String, String> create(@RequestBody(required = false) Object ignoredBody) {
        return Map.of("id", store.createSession());
    }

    @PostMapping("/sessions/{id}/events")
    public SessionEvent append(
            @PathVariable String id, @RequestBody(required = false) AppendEventRequest request) {
        AppendEventRequest req = request == null
                ? new AppendEventRequest(null, null, null) : request;
        return store.append(id, req.type(), req.payload(), req.clientEventId());
    }

    @GetMapping("/sessions/{id}")
    public SessionView get(@PathVariable String id) {
        // Triggers a 404 (via the handler below) when the session is unknown.
        return new SessionView(id, store.events(id), store.projection(id));
    }

    @GetMapping(value = "/sessions/{id}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@PathVariable String id) {
        return store.subscribe(id);
    }

    @ExceptionHandler(NoSuchElementException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public Map<String, String> handleUnknownSession(NoSuchElementException e) {
        return Map.of("error", e.getMessage() == null ? "not found" : e.getMessage());
    }
}
