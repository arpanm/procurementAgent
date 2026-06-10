import { describe, expect, it } from "vitest";
import type { Observation } from "../automation/AutomationEngine";
import { parseOrderConfirmation } from "./OrderConfirmationParser";

describe("parseOrderConfirmation", () => {
  it("prefers the structured PlaceOrderResult", () => {
    const parsed = parseOrderConfirmation({
      result: { orderRef: "HP-123", totalPaise: 5000, paidOnCredit: true },
    });
    expect(parsed).toEqual({ orderRef: "HP-123", totalPaise: 5000, paidOnCredit: true });
  });

  it("extracts order ref and total from confirmation text", () => {
    const parsed = parseOrderConfirmation({
      text: "Thank you! Order ID: ABX-99812. Total ₹1,234.50 paid on credit.",
    });
    expect(parsed.orderRef).toBe("ABX-99812");
    expect(parsed.totalPaise).toBe(123450);
    expect(parsed.paidOnCredit).toBe(true);
  });

  it("parses 'Order no.' and 'Rs' variants", () => {
    const parsed = parseOrderConfirmation({
      text: "Order no. 778899 placed. Rs 980 due now.",
    });
    expect(parsed.orderRef).toBe("778899");
    expect(parsed.totalPaise).toBe(98000);
    expect(parsed.paidOnCredit).toBe(false);
  });

  it("extracts from an observation (title + element names)", () => {
    const observation: Observation = {
      url: "https://hyperpure.com/order/success",
      title: "Order Confirmed",
      scroll: { y: 0, h: 1000, vh: 800 },
      elements: [
        {
          idx: 0,
          tag: "div",
          role: null,
          name: "Order reference: HP9X8Y",
          value: null,
          bbox: [0, 0, 10, 10],
          attrs: {},
        },
        {
          idx: 1,
          tag: "div",
          role: null,
          name: "Total ₹2,000",
          value: null,
          bbox: [0, 0, 10, 10],
          attrs: {},
        },
      ],
    };
    const parsed = parseOrderConfirmation({ observation });
    expect(parsed.orderRef).toBe("HP9X8Y");
    expect(parsed.totalPaise).toBe(200000);
  });

  it("is robust to missing fields", () => {
    expect(parseOrderConfirmation({})).toEqual({
      orderRef: null,
      totalPaise: null,
      paidOnCredit: false,
    });
    expect(parseOrderConfirmation({ text: "Something went wrong" })).toEqual({
      orderRef: null,
      totalPaise: null,
      paidOnCredit: false,
    });
  });

  it("falls back to text when the result has an empty orderRef", () => {
    const parsed = parseOrderConfirmation({
      result: { orderRef: "", totalPaise: 0, paidOnCredit: false },
      text: "Order ID: FALLBACK-1",
    });
    // totalPaise from the (finite) result wins; orderRef falls back to text.
    expect(parsed.orderRef).toBe("FALLBACK-1");
    expect(parsed.totalPaise).toBe(0);
  });
});
