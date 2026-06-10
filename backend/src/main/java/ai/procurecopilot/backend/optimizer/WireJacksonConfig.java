package ai.procurecopilot.backend.optimizer;

import ai.procurecopilot.backend.common.PlatformId;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.module.SimpleModule;
import java.io.IOException;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Binds {@link PlatformId} to the app's lowercase wire contract ("hyperpure" / "amazon") on every
 * endpoint, using the shared {@code wire()} / {@code fromWire()} helpers. This keeps the JSON the
 * Capacitor {@code BackendClient} sends and receives consistent without redefining the enum. Spring
 * Boot auto-registers any {@link com.fasterxml.jackson.databind.Module} bean with its ObjectMapper.
 */
@Configuration
public class WireJacksonConfig {

    @Bean
    public SimpleModule platformIdWireModule() {
        SimpleModule module = new SimpleModule("PlatformIdWireModule");
        module.addSerializer(PlatformId.class, new PlatformIdSerializer());
        module.addDeserializer(PlatformId.class, new PlatformIdDeserializer());
        return module;
    }

    private static final class PlatformIdSerializer extends JsonSerializer<PlatformId> {
        @Override
        public void serialize(PlatformId value, JsonGenerator gen, SerializerProvider serializers)
                throws IOException {
            gen.writeString(value.wire());
        }
    }

    private static final class PlatformIdDeserializer extends JsonDeserializer<PlatformId> {
        @Override
        public PlatformId deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
            String raw = p.getValueAsString();
            if (raw == null || raw.isBlank()) {
                return null;
            }
            return PlatformId.fromWire(raw);
        }
    }
}
