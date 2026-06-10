import { describe, expect, it } from "vitest";
import { REDACTION_PLACEHOLDER, scrubForApi } from "./scrubForApi";

describe("scrubForApi", () => {
  it("redacts email addresses", () => {
    const out = scrubForApi("mail me at owner.kirana@example.co.in for the order");
    expect(out).not.toContain("owner.kirana@example.co.in");
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("redacts Indian phone numbers in various formats", () => {
    expect(scrubForApi("call 9876543210")).not.toMatch(/9876543210/);
    expect(scrubForApi("call +91 98765 43210")).not.toMatch(/\d/);
    expect(scrubForApi("ring me 098765-43210 today")).not.toMatch(/\d/);
  });

  it("redacts OTP-like codes both labelled and bare", () => {
    expect(scrubForApi("my OTP is 482913")).not.toMatch(/482913/);
    expect(scrubForApi("482913")).toBe(REDACTION_PLACEHOLDER);
    expect(scrubForApi("the code 9931")).not.toMatch(/9931/);
  });

  it("redacts obvious credential strings", () => {
    const out = scrubForApi("password: hunter2 and pin 4321");
    expect(out).not.toContain("hunter2");
    expect(out).not.toMatch(/4321/);
  });

  it("leaves a normal vernacular order intact", () => {
    expect(scrubForApi("5 kilo aloo aur 2 carton tel")).toBe("5 kilo aloo aur 2 carton tel");
  });

  it("preserves small order quantities", () => {
    expect(scrubForApi("order 10kg onions and 2 dozen eggs")).toBe(
      "order 10kg onions and 2 dozen eggs",
    );
  });

  it("returns an empty string for empty / non-string input", () => {
    expect(scrubForApi("")).toBe("");
    expect(scrubForApi(undefined as unknown as string)).toBe("");
  });
});
