import { describe, expect, it, vi } from "vitest";
import type {
  BackendClient,
  IntentRequest,
  IntentResponse,
} from "../backend/BackendClient";
import type { RequestedItem } from "../domain/types";
import { IntentClient } from "./IntentClient";

const ITEMS: readonly RequestedItem[] = [
  { raw: "5 kilo aloo", name: "potato", qty: 5, unit: "kg" },
  { raw: "2 carton tel", name: "refined oil", qty: 2, unit: "carton" },
];

/** Builds a BackendClient whose only meaningful method is `intent`. */
function makeBackend(intent: (req: IntentRequest) => Promise<IntentResponse>): {
  backend: BackendClient;
  intent: ReturnType<typeof vi.fn>;
} {
  const intentMock = vi.fn(intent);
  const reject = () => Promise.reject(new Error("not used in this test"));
  const backend: BackendClient = {
    intent: intentMock as unknown as BackendClient["intent"],
    plan: reject as unknown as BackendClient["plan"],
    nextAction: reject as unknown as BackendClient["nextAction"],
    verify: reject as unknown as BackendClient["verify"],
    optimize: reject as unknown as BackendClient["optimize"],
    appendEvent: reject as unknown as BackendClient["appendEvent"],
    createSession: reject as unknown as BackendClient["createSession"],
    getSession: reject as unknown as BackendClient["getSession"],
  };
  return { backend, intent: intentMock };
}

describe("IntentClient", () => {
  it("returns the items the backend extracted", async () => {
    const { backend } = makeBackend(async () => ({ items: ITEMS, confidence: 0.9 }));
    const client = new IntentClient(backend);
    const items = await client.parse("5 kilo aloo aur 2 carton tel", "hi-IN");
    expect(items).toEqual(ITEMS);
  });

  it("scrubs secrets before sending text to the backend", async () => {
    const { backend, intent } = makeBackend(async () => ({ items: ITEMS, confidence: 0.9 }));
    const client = new IntentClient(backend);
    await client.parse("5 kilo aloo, my otp is 482913 phone 9876543210", "hi-IN");

    expect(intent).toHaveBeenCalledTimes(1);
    const sent = intent.mock.calls[0][0] as IntentRequest;
    expect(sent.text).not.toMatch(/482913/);
    expect(sent.text).not.toMatch(/9876543210/);
    expect(sent.text).toContain("5 kilo aloo");
    expect(sent.locale).toBe("hi-IN");
  });

  it("returns an empty array without calling the backend when scrubbed text is empty", async () => {
    const { backend, intent } = makeBackend(async () => ({ items: ITEMS, confidence: 0.9 }));
    const client = new IntentClient(backend);
    const items = await client.parse("   ");
    expect(items).toEqual([]);
    expect(intent).not.toHaveBeenCalled();
  });

  it("flags low-confidence extractions while still returning items", async () => {
    const { backend } = makeBackend(async () => ({ items: ITEMS, confidence: 0.2 }));
    const client = new IntentClient(backend);
    const result = await client.parseWithConfidence("kuch saaman");
    expect(result.items).toEqual(ITEMS);
    expect(result.lowConfidence).toBe(true);
  });
});
