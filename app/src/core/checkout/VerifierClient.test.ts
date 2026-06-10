import { describe, expect, it, vi } from "vitest";
import type { CartSnapshot } from "../automation/AutomationEngine";
import type { BackendClient } from "../backend/BackendClient";
import type { AllocationLine } from "../domain/types";
import { VerifierClient, localCartMismatches } from "./VerifierClient";

const PLAN: AllocationLine[] = [
  {
    canonicalItemId: "potato",
    itemName: "potato",
    platform: "hyperpure",
    skuId: "hp-potato",
    qty: 5,
    unitPricePaise: 1000,
    lineTotalPaise: 5000,
    reason: "x",
  },
];

const MATCH: CartSnapshot = {
  platform: "hyperpure",
  lines: [{ skuId: "hp-potato", title: "Potato", qty: 5, unitPricePaise: 1000 }],
  subtotalPaise: 5000,
};

function backendOk(): BackendClient {
  return {
    verify: (async () => ({ ok: true, mismatches: [] })) as unknown as BackendClient["verify"],
  } as unknown as BackendClient;
}

describe("localCartMismatches", () => {
  it("returns no mismatch when cart matches plan", () => {
    expect(localCartMismatches(MATCH, PLAN)).toEqual([]);
  });

  it("flags wrong qty", () => {
    const cart = { ...MATCH, lines: [{ ...MATCH.lines[0], qty: 4 }] };
    expect(localCartMismatches(cart, PLAN)).toHaveLength(1);
    expect(localCartMismatches(cart, PLAN)[0]).toMatch(/qty/i);
  });

  it("flags price beyond tolerance but allows drift within tolerance", () => {
    const cart = { ...MATCH, lines: [{ ...MATCH.lines[0], unitPricePaise: 1100 }] };
    expect(localCartMismatches(cart, PLAN, 0)).toHaveLength(1);
    expect(localCartMismatches(cart, PLAN, 100)).toHaveLength(0);
    expect(localCartMismatches(cart, PLAN, 50)).toHaveLength(1);
  });

  it("flags a missing sku", () => {
    const cart = { ...MATCH, lines: [] };
    expect(localCartMismatches(cart, PLAN)[0]).toMatch(/missing/i);
  });

  it("flags an extra sku", () => {
    const cart = {
      ...MATCH,
      lines: [
        ...MATCH.lines,
        { skuId: "hp-onion", title: "Onion", qty: 1, unitPricePaise: 800 },
      ],
    };
    expect(localCartMismatches(cart, PLAN)[0]).toMatch(/extra/i);
  });
});

describe("VerifierClient", () => {
  it("passes when local + backend both agree", async () => {
    const verifier = new VerifierClient(backendOk());
    const res = await verifier.assertCartMatches(MATCH, PLAN);
    expect(res.ok).toBe(true);
    expect(res.mismatches).toEqual([]);
  });

  it("blocks when local check fails, regardless of backend", async () => {
    const verifier = new VerifierClient(backendOk());
    const cart = { ...MATCH, lines: [{ ...MATCH.lines[0], qty: 99 }] };
    const res = await verifier.assertCartMatches(cart, PLAN);
    expect(res.ok).toBe(false);
    expect(res.mismatches.length).toBeGreaterThan(0);
  });

  it("blocks when the backend rejects even if local matches", async () => {
    const backend = {
      verify: (async () => ({
        ok: false,
        mismatches: ["backend says price changed"],
      })) as unknown as BackendClient["verify"],
    } as unknown as BackendClient;
    const verifier = new VerifierClient(backend);
    const res = await verifier.assertCartMatches(MATCH, PLAN);
    expect(res.ok).toBe(false);
    expect(res.mismatches).toContain("backend says price changed");
  });

  it("blocks (does not throw) when the backend verifier is unavailable", async () => {
    const backend = {
      verify: (async () => {
        throw new Error("network down");
      }) as unknown as BackendClient["verify"],
    } as unknown as BackendClient;
    const verifier = new VerifierClient(backend);
    const res = await verifier.assertCartMatches(MATCH, PLAN);
    expect(res.ok).toBe(false);
    expect(res.mismatches.join(" ")).toMatch(/unavailable/i);
  });

  it("honours a configured price tolerance", async () => {
    const verify = vi.fn(async () => ({ ok: true, mismatches: [] }));
    const backend = { verify } as unknown as BackendClient;
    const verifier = new VerifierClient(backend, { tolerancePaise: 100 });
    const cart = { ...MATCH, lines: [{ ...MATCH.lines[0], unitPricePaise: 1080 }] };
    const res = await verifier.assertCartMatches(cart, PLAN);
    expect(res.ok).toBe(true);
  });
});
