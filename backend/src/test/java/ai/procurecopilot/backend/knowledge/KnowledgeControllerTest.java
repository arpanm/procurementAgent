package ai.procurecopilot.backend.knowledge;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.hamcrest.Matchers;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * End-to-end wire tests for the guided-RAG /knowledge endpoints. Confirms the curated seed contract
 * (camelCase JSON), unknown-platform 400s, and that an appended observation is reflected both in the
 * POST response and a subsequent GET.
 */
@SpringBootTest
@AutoConfigureMockMvc
class KnowledgeControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void amazonKnowledgeServesPoliciesAndHints() throws Exception {
        mockMvc.perform(get("/knowledge/amazon"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.platform").value("amazon"))
                .andExpect(jsonPath("$.policies.priceFromDetailPage").value(true))
                .andExpect(jsonPath("$.hints.atcTokens", Matchers.hasItem("add to cart")));
    }

    @Test
    void hyperpureKnowledgeTrustsListingPrice() throws Exception {
        mockMvc.perform(get("/knowledge/hyperpure"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.policies.trustListingPrice").value(true));
    }

    @Test
    void unknownPlatformReturnsBadRequest() throws Exception {
        mockMvc.perform(get("/knowledge/bogus"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void observationIsAppendedAndPersisted() throws Exception {
        String body = "{\"kind\":\"selector\","
                + "\"text\":\"buybox price is #corePrice_feature_div\"}";
        mockMvc.perform(post("/knowledge/amazon/observations")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.notes[*].text",
                        Matchers.hasItem("buybox price is #corePrice_feature_div")))
                .andExpect(jsonPath("$.notes[*].kind", Matchers.hasItem("selector")));

        mockMvc.perform(get("/knowledge/amazon"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.notes[*].text",
                        Matchers.hasItem("buybox price is #corePrice_feature_div")));
    }

    @Test
    void blankObservationTextReturnsBadRequest() throws Exception {
        String body = "{\"kind\":\"selector\",\"text\":\"   \"}";
        mockMvc.perform(post("/knowledge/amazon/observations")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest());
    }
}
