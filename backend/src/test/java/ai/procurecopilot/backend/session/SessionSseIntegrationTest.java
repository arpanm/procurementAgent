package ai.procurecopilot.backend.session;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * Live-push SSE test (PROCURE_COPILOT_PLAN.md §3.6.5): an event appended after a client subscribes to
 * {@code /sessions/{id}/stream} is pushed over the stream. Runs against a real port because SSE is an
 * async streaming response. The store is the injected singleton, so the appended event reaches the
 * subscribed emitter.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        // The open SSE request is an active async request; immediate shutdown avoids Tomcat's graceful
        // 30s wait for it when the test context closes.
        properties = "server.shutdown=immediate")
class SessionSseIntegrationTest {

    @LocalServerPort
    private int port;

    @Autowired
    private SessionStore store;

    @Test
    void appendAfterSubscribeIsPushedOverSse() throws Exception {
        String sessionId = store.createSession();
        HttpClient client = HttpClient.newHttpClient();

        HttpRequest streamRequest = HttpRequest.newBuilder()
                .uri(URI.create("http://localhost:" + port + "/sessions/" + sessionId + "/stream"))
                .header("Accept", "text/event-stream")
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        HttpResponse<java.io.InputStream> response =
                client.send(streamRequest, HttpResponse.BodyHandlers.ofInputStream());
        // A committed 200 response means Spring has registered the emitter with the store.
        assertThat(response.statusCode()).isEqualTo(200);

        CountDownLatch received = new CountDownLatch(1);
        AtomicReference<String> dataLine = new AtomicReference<>();
        Thread reader = new Thread(() -> {
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(response.body(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = in.readLine()) != null) {
                    if (line.startsWith("data:")) {
                        dataLine.set(line);
                        received.countDown();
                        return;
                    }
                }
            } catch (Exception ignored) {
                // Stream closed by the test; nothing to do.
            }
        });
        reader.setDaemon(true);
        reader.start();

        // Append after the subscription is live; this must be pushed to the open stream.
        store.append(sessionId, "PlanCreated", java.util.Map.of("status", "planning"));

        assertThat(received.await(8, TimeUnit.SECONDS))
                .as("SSE event should arrive within timeout").isTrue();
        assertThat(dataLine.get()).contains("PlanCreated");

        // Release the stream and client so the server-side emitter is cleaned up promptly.
        reader.interrupt();
        response.body().close();
        client.close();
    }
}
