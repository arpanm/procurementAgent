package ai.procurecopilot.backend.llm;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * LLM provider selection ({@code llm.*}). The backend can talk to Anthropic (the default, paid) or to a
 * local <b>Ollama</b> server (free, offline) — see {@link OllamaClient}. Switch with {@code LLM_PROVIDER}.
 *
 * <p>For a fully-free setup: {@code LLM_PROVIDER=ollama}, {@code ANTHROPIC_STUB_MODE=false}, and an Ollama
 * server reachable at {@code ollama.base-url} with the text + vision models pulled. No Anthropic key.
 */
@ConfigurationProperties(prefix = "llm")
public record LlmProperties(String provider, Ollama ollama) {

    public record Ollama(String baseUrl, String model, String visionModel) {
        public String baseUrlOrDefault() {
            return baseUrl == null || baseUrl.isBlank() ? "http://localhost:11434" : baseUrl;
        }

        public String modelOrDefault() {
            return model == null || model.isBlank() ? "qwen2.5:7b" : model;
        }

        /** Vision-language model for screenshot reads (price extraction); falls back to the text model. */
        public String visionModelOrDefault() {
            return visionModel == null || visionModel.isBlank() ? modelOrDefault() : visionModel;
        }
    }

    /** True when the local Ollama provider is selected. */
    public boolean isOllama() {
        return "ollama".equalsIgnoreCase(provider);
    }

    public Ollama ollamaOrDefault() {
        return ollama != null ? ollama : new Ollama(null, null, null);
    }
}
