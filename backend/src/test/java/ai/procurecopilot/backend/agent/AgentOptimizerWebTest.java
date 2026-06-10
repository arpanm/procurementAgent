package ai.procurecopilot.backend.agent;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * End-to-end wire tests: confirms the /intent, /plan and /optimize endpoints speak the app's
 * camelCase contract and that {@link ai.procurecopilot.backend.common.PlatformId} (de)serializes as
 * the lowercase wire strings the Capacitor BackendClient sends ("hyperpure" / "amazon").
 */
@SpringBootTest
@AutoConfigureMockMvc
class AgentOptimizerWebTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void intentEndpointReturnsItemsAndConfidence() throws Exception {
        mockMvc.perform(post("/intent")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"5 kilo aloo aur 2 carton tel\",\"locale\":\"hi-IN\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items.length()").value(2))
                .andExpect(jsonPath("$.items[0].canonicalItemId").value("potato"))
                .andExpect(jsonPath("$.items[0].qty").value(5))
                .andExpect(jsonPath("$.items[0].unit").value("kg"))
                .andExpect(jsonPath("$.items[1].canonicalItemId").value("oil"))
                .andExpect(jsonPath("$.confidence").isNumber());
    }

    @Test
    void planEndpointReturnsNormalizedItemsAndBothPlatforms() throws Exception {
        mockMvc.perform(post("/plan")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"requestText\":\"order\",\"items\":["
                                + "{\"canonicalItemId\":\"potato\",\"name\":\"potato\",\"qty\":2,\"unit\":\"kg\"},"
                                + "{\"canonicalItemId\":\"potato\",\"name\":\"potato\",\"qty\":3,\"unit\":\"kg\"}]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.normalizedItems.length()").value(1))
                .andExpect(jsonPath("$.normalizedItems[0].qty").value(5))
                .andExpect(jsonPath("$.platforms[0]").value("hyperpure"))
                .andExpect(jsonPath("$.platforms[1]").value("amazon"));
    }

    @Test
    void optimizeEndpointRoundTripsLowercasePlatformWire() throws Exception {
        String body = "{"
                + "\"items\":[{\"canonicalItemId\":\"potato\",\"name\":\"potato\",\"qty\":2,\"unit\":\"kg\"}],"
                + "\"quotes\":[{\"platform\":\"hyperpure\",\"skuId\":\"hp-potato\","
                + "\"canonicalItemId\":\"potato\",\"title\":\"Potato 1kg\",\"pricePaise\":1000,"
                + "\"inStock\":true}],"
                + "\"constraints\":[{\"platform\":\"hyperpure\",\"movPaise\":0,\"deliveryFeePaise\":0}]"
                + "}";
        mockMvc.perform(post("/optimize")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.perPlatform[0].platform").value("hyperpure"))
                .andExpect(jsonPath("$.perPlatform[0].lines[0].canonicalItemId").value("potato"))
                .andExpect(jsonPath("$.perPlatform[0].lines[0].qty").value(2))
                .andExpect(jsonPath("$.grandTotalPaise").value(2000));
    }
}
