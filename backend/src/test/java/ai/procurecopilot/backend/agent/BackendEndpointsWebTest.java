package ai.procurecopilot.backend.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * End-to-end wire tests for the Verifier, grounding, playbook and session endpoints. Confirms the
 * camelCase JSON contract the Capacitor BackendClient speaks and that {@code PlatformId}
 * (de)serializes as lowercase wire strings ("hyperpure" / "amazon").
 */
@SpringBootTest
@AutoConfigureMockMvc
class BackendEndpointsWebTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

    @Test
    void verifyEndpointPassesOnExactCartAndBlocksOnDrift() throws Exception {
        String ok = "{\"platform\":\"hyperpure\","
                + "\"expected\":[{\"skuId\":\"hp-onion\",\"qty\":10,\"unitPricePaise\":5000}],"
                + "\"actual\":[{\"skuId\":\"hp-onion\",\"qty\":10,\"unitPricePaise\":5000}]}";
        mockMvc.perform(post("/verify").contentType(MediaType.APPLICATION_JSON).content(ok))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true))
                .andExpect(jsonPath("$.mismatches.length()").value(0));

        String drift = "{\"platform\":\"hyperpure\","
                + "\"expected\":[{\"skuId\":\"hp-onion\",\"qty\":10,\"unitPricePaise\":5000}],"
                + "\"actual\":[{\"skuId\":\"hp-onion\",\"qty\":10,\"unitPricePaise\":9000}]}";
        mockMvc.perform(post("/verify").contentType(MediaType.APPLICATION_JSON).content(drift))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(false))
                .andExpect(jsonPath("$.mismatches.length()").value(1));
    }

    @Test
    void intentEndpointSerializesBrandVariantAndPackSize() throws Exception {
        String body = "{\"text\":\"order 1kg india gate basmati rice 5 packets and "
                + "tata lite salt 1 kg 3 packets\",\"locale\":\"en-IN\"}";
        mockMvc.perform(post("/intent").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2))
                .andExpect(jsonPath("$.items[0].canonicalItemId").value("rice"))
                .andExpect(jsonPath("$.items[0].brand").value("India Gate"))
                .andExpect(jsonPath("$.items[0].variant").value("basmati"))
                .andExpect(jsonPath("$.items[0].packSize").value("1 kg"))
                .andExpect(jsonPath("$.items[0].qty").value(5))
                .andExpect(jsonPath("$.items[0].unit").value("packet"))
                .andExpect(jsonPath("$.items[1].canonicalItemId").value("salt"))
                .andExpect(jsonPath("$.items[1].brand").value("Tata"))
                .andExpect(jsonPath("$.items[1].variant").value("lite"))
                .andExpect(jsonPath("$.items[1].packSize").value("1 kg"))
                .andExpect(jsonPath("$.items[1].qty").value(3))
                .andExpect(jsonPath("$.items[1].unit").value("packet"));
    }

    @Test
    void nextActionEndpointReturnsOneAction() throws Exception {
        String body = "{\"platform\":\"hyperpure\",\"task\":\"search onions\","
                + "\"observation\":{\"url\":\"https://hyperpure.com\",\"title\":\"Hyperpure\","
                + "\"scroll\":{\"y\":0,\"h\":2000,\"vh\":800},"
                + "\"elements\":[{\"idx\":3,\"tag\":\"input\",\"role\":\"searchbox\","
                + "\"name\":\"Search for products\",\"value\":null,\"bbox\":[0,0,10,10],"
                + "\"attrs\":{\"type\":\"search\"}}]},\"history\":[]}";
        mockMvc.perform(post("/next-action").contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.type").value("type"))
                .andExpect(jsonPath("$.idx").value(3));
    }

    @Test
    void playbooksEndpointReturnsSeededFlowsForPlatform() throws Exception {
        mockMvc.perform(get("/playbooks/hyperpure"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].platform").value("hyperpure"))
                .andExpect(jsonPath("$.length()").value(org.hamcrest.Matchers.greaterThanOrEqualTo(4)));

        mockMvc.perform(get("/playbooks/amazon/search"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.platform").value("amazon"))
                .andExpect(jsonPath("$.flow").value("search"));

        mockMvc.perform(get("/playbooks/hyperpure/missingflow"))
                .andExpect(status().isNotFound());

        mockMvc.perform(get("/playbooks/notaplatform"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void playbookUpsertPromotesCandidate() throws Exception {
        String body = "{\"flow\":\"search\",\"version\":9,"
                + "\"steps\":[{\"action\":\"click\",\"selector\":\"#search\"}]}";
        mockMvc.perform(post("/playbooks/hyperpure")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.platform").value("hyperpure"))
                .andExpect(jsonPath("$.flow").value("search"))
                .andExpect(jsonPath("$.version").value(9));
    }

    @Test
    void sessionLifecycleCreateAppendGet() throws Exception {
        MvcResult created = mockMvc.perform(post("/sessions")
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").exists())
                .andReturn();
        JsonNode createdJson = mapper.readTree(created.getResponse().getContentAsString());
        String id = createdJson.get("id").asText();
        assertThat(id).isNotBlank();

        mockMvc.perform(post("/sessions/" + id + "/events")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"PlanCreated\",\"payload\":{\"status\":\"planning\"},"
                                + "\"clientEventId\":\"c1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.seq").value(0))
                .andExpect(jsonPath("$.type").value("PlanCreated"));

        // Idempotent retry with the same clientEventId must not append a second event.
        mockMvc.perform(post("/sessions/" + id + "/events")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"PlanCreated\",\"payload\":{\"status\":\"planning\"},"
                                + "\"clientEventId\":\"c1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.seq").value(0));

        mockMvc.perform(get("/sessions/" + id))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(id))
                .andExpect(jsonPath("$.events.length()").value(1))
                .andExpect(jsonPath("$.projection.status").value("planning"))
                .andExpect(jsonPath("$.projection.eventCount").value(1));

        mockMvc.perform(get("/sessions/does-not-exist"))
                .andExpect(status().isNotFound());
    }
}
