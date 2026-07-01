package ai.procurecopilot.backend.eval;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
 * End-to-end wire tests for the eval-observability endpoints (stub Claude). Confirms failure ingest,
 * a manual run, run/pending listings, and the 4xx contract for bad platform / payload / patch id.
 */
@SpringBootTest
@AutoConfigureMockMvc
class EvalControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void ingestingASingleFailureSucceedsWithoutTriggeringAnEval() throws Exception {
        String body = "{\"flow\":\"addToCart\",\"signature\":\"wire-sku-1\",\"reason\":\"no ADD\","
                + "\"skuId\":\"wire-sku-1\",\"itemName\":\"Paneer\",\"at\":\"2026-06-30T12:00:00Z\"}";
        mockMvc.perform(post("/eval/hyperpure/failures")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.failureId").isNumber())
                .andExpect(jsonPath("$.evalTriggered").value(false));
    }

    @Test
    void manualRunReturnsAnEvalRunView() throws Exception {
        mockMvc.perform(post("/eval/hyperpure/run"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.platform").value("hyperpure"))
                .andExpect(jsonPath("$.trigger").value("MANUAL"))
                .andExpect(jsonPath("$.status").exists());
    }

    @Test
    void runsAndPendingListingsAreArrays() throws Exception {
        mockMvc.perform(get("/eval/hyperpure/runs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray());
        mockMvc.perform(get("/eval/hyperpure/pending"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isArray());
    }

    @Test
    void unknownPlatformIsRejected() throws Exception {
        mockMvc.perform(post("/eval/bogus/run")).andExpect(status().isBadRequest());
    }

    @Test
    void failureWithoutAnyIdentifierIsRejected() throws Exception {
        String body = "{\"flow\":\"addToCart\",\"reason\":\"no ADD\"}";
        mockMvc.perform(post("/eval/hyperpure/failures")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest());
    }

    @Test
    void promotingAMissingPatchIs404() throws Exception {
        mockMvc.perform(post("/eval/hyperpure/pending/999999/promote"))
                .andExpect(status().isNotFound());
    }
}
