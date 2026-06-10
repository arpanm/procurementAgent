/**
 * The Verifier / Critic safety gate (PROCURE_COPILOT_PLAN.md §3.3, Epic 6). Before any irreversible
 * step (checkout) it re-reads the platform cart and asserts it matches the approved plan — right SKU,
 * right qty, price within tolerance, no missing or extra lines. It BLOCKS on any mismatch.
 *
 * Defense-in-depth: the backend `verify` endpoint is the reasoning provider (Claude), but we also run
 * a deterministic local comparison on-device. The cart is judged OK only if BOTH agree it is OK, so a
 * mis-behaving or unreachable backend can never wave through a tampered cart. The local check is the
 * authoritative safety floor; the backend can only add mismatches, never remove them.
 */
import type { CartSnapshot } from "../automation/AutomationEngine";
import type { BackendClient } from "../backend/BackendClient";
import type { AllocationLine } from "../domain/types";

export interface VerifyResult {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
}

export interface VerifierOptions {
  /**
   * Allowed absolute per-unit price drift, in paise, before a line is flagged. Defaults to 0 (exact
   * match required). Prices on B2B platforms can wobble by a rupee between read and checkout; raise
   * this only as far as the business tolerates.
   */
  readonly tolerancePaise?: number;
}

interface LineSpec {
  readonly skuId: string;
  readonly qty: number;
  readonly unitPricePaise: number;
}

/** Sum quantities per SKU so the comparison is order-independent and merges duplicate lines. */
function aggregate(lines: readonly LineSpec[]): Map<string, LineSpec> {
  const map = new Map<string, LineSpec>();
  for (const line of lines) {
    const existing = map.get(line.skuId);
    if (existing) {
      map.set(line.skuId, {
        skuId: line.skuId,
        qty: existing.qty + line.qty,
        // Keep the first observed unit price; qty mismatch will surface separately.
        unitPricePaise: existing.unitPricePaise,
      });
    } else {
      map.set(line.skuId, line);
    }
  }
  return map;
}

/**
 * Deterministic on-device comparison of the actual cart against the approved plan. Catches wrong qty,
 * price drift beyond tolerance, missing SKUs and extra SKUs. Pure and synchronous.
 */
export function localCartMismatches(
  cart: CartSnapshot,
  plan: readonly AllocationLine[],
  tolerancePaise = 0,
): string[] {
  const mismatches: string[] = [];

  const expected = aggregate(
    plan.map((l) => ({
      skuId: l.skuId,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
    })),
  );
  const actual = aggregate(
    cart.lines.map((l) => ({
      skuId: l.skuId,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
    })),
  );

  for (const [skuId, exp] of expected) {
    const act = actual.get(skuId);
    if (!act) {
      mismatches.push(`Missing SKU ${skuId}: planned qty ${exp.qty} but it is not in the cart.`);
      continue;
    }
    if (act.qty !== exp.qty) {
      mismatches.push(
        `Wrong qty for SKU ${skuId}: planned ${exp.qty}, cart has ${act.qty}.`,
      );
    }
    const drift = Math.abs(act.unitPricePaise - exp.unitPricePaise);
    if (drift > tolerancePaise) {
      mismatches.push(
        `Price mismatch for SKU ${skuId}: planned ${exp.unitPricePaise} paise, cart has ${act.unitPricePaise} paise (drift ${drift} > tolerance ${tolerancePaise}).`,
      );
    }
  }

  for (const skuId of actual.keys()) {
    if (!expected.has(skuId)) {
      mismatches.push(`Extra SKU ${skuId}: present in the cart but not in the approved plan.`);
    }
  }

  return mismatches;
}

export class VerifierClient {
  private readonly tolerancePaise: number;

  constructor(
    private readonly backend: BackendClient,
    options: VerifierOptions = {},
  ) {
    this.tolerancePaise = options.tolerancePaise ?? 0;
  }

  /**
   * Assert the cart matches the approved plan. Returns `{ ok, mismatches }`. `ok` is true only when
   * the local check finds no mismatch AND the backend verifier also approves; either source of doubt
   * blocks checkout. A backend error is treated as a (non-fatal) failure to confirm, so it blocks.
   */
  async assertCartMatches(
    cart: CartSnapshot,
    plan: readonly AllocationLine[],
  ): Promise<VerifyResult> {
    const local = localCartMismatches(cart, plan, this.tolerancePaise);

    const expected = plan.map((l) => ({
      skuId: l.skuId,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
    }));
    const actual = cart.lines.map((l) => ({
      skuId: l.skuId,
      qty: l.qty,
      unitPricePaise: l.unitPricePaise,
    }));

    let backendOk = true;
    const backendMismatches: string[] = [];
    try {
      const res = await this.backend.verify({
        platform: cart.platform,
        expected,
        actual,
      });
      backendOk = res.ok;
      backendMismatches.push(...res.mismatches);
    } catch (err) {
      backendOk = false;
      backendMismatches.push(
        `Backend verifier unavailable: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }

    const mismatches = [...local, ...backendMismatches];
    return { ok: local.length === 0 && backendOk, mismatches };
  }
}
