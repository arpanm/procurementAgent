package ai.procurecopilot.backend.llm;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class SecretScrubberTest {

    private final SecretScrubber scrubber = new SecretScrubber();

    @Test
    void redactsEmails() {
        String out = scrubber.scrub("contact ramesh@kirana.in for details");
        assertThat(out).doesNotContain("ramesh@kirana.in").contains("[REDACTED_EMAIL]");
    }

    @Test
    void redactsIndianPhoneNumbers() {
        assertThat(scrubber.scrub("call +91 98765 43210 now")).doesNotContain("98765");
        assertThat(scrubber.scrub("call 9876543210")).doesNotContain("9876543210");
    }

    @Test
    void redactsOtpCodes() {
        assertThat(scrubber.scrub("your OTP is 482913")).doesNotContain("482913");
        assertThat(scrubber.scrub("one-time code 1234")).contains("[REDACTED");
    }

    @Test
    void redactsCredentialsAndTokens() {
        assertThat(scrubber.scrub("password: hunter2secret")).doesNotContain("hunter2secret");
        String jwt = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef123456";
        assertThat(scrubber.scrub(jwt)).doesNotContain("eyJhbGci");
    }

    @Test
    void leavesOrdinaryProductTextIntact() {
        String text = "Onions 10kg in stock, delivery tomorrow";
        assertThat(scrubber.scrub(text)).isEqualTo(text);
    }

    @Test
    void preservesStructuredGroundingJson() {
        // Regression: the scrubber must not corrupt the serialized-observation JSON sent for
        // grounding — keys like "task", element indices, prices in paise and bbox coordinates
        // (4-8 digit numbers) must survive intact.
        String json = "{\"task\":\"next-action\",\"elements\":[{\"idx\":12,"
                + "\"name\":\"Add to cart\",\"pricePaise\":215050,"
                + "\"bbox\":[1200,3400,80,44]}]}";
        String out = scrubber.scrub(json);
        assertThat(out).isEqualTo(json);
        assertThat(out).doesNotContain("REDACTED");
    }

    @Test
    void doesNotRedactBarePricesOrCoordinates() {
        assertThat(scrubber.scrub("price 215050 paise")).isEqualTo("price 215050 paise");
        assertThat(scrubber.scrub("bbox 1200 3400")).isEqualTo("bbox 1200 3400");
    }

    @Test
    void handlesNullAndEmpty() {
        assertThat(scrubber.scrub(null)).isNull();
        assertThat(scrubber.scrub("")).isEmpty();
    }
}
