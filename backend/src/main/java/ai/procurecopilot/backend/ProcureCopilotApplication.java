package ai.procurecopilot.backend;

import java.time.Clock;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Entry point for the Procure Copilot backend.
 *
 * <p>The backend is a stateless reasoning provider plus a durable event store, as described in
 * {@code PROCURE_COPILOT_PLAN.md} §3.5/§3.6. It hosts the Anthropic proxy (key off-device), the
 * agent brain endpoints (plan / next-action / verify), the playbook registry, the cart-split
 * optimizer, the session event store, telemetry, and the guided-RAG eval pipeline (scheduling
 * enabled for the daily self-improvement sweep).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
@EnableScheduling
public class ProcureCopilotApplication {

    public static void main(String[] args) {
        SpringApplication.run(ProcureCopilotApplication.class, args);
    }

    /** UTC clock so scheduled/triggered eval timestamps are deterministic and testable. */
    @Bean
    public Clock clock() {
        return Clock.systemUTC();
    }
}
