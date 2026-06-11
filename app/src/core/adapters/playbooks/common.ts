/**
 * Shared deterministic playbook builder for the WebView site adapters
 * (PROCURE_COPILOT_PLAN.md §3.5.7 playbook-first, §3.5.11 worked example).
 *
 * Hyperpure and Amazon share the same flow shape — focus the searchbox, type, submit, read the first
 * matching card, add it to the cart, then walk cart → checkout — so the steps live here once and each
 * platform file specialises only the display name / prompts. Every step is a pure function over the
 * serialized `Observation`; it returns an `EngineAction` when confident, a `needs_human` action at an
 * OTP/payment/re-login boundary, or `null` to defer to the Claude-grounded backend (self-heal).
 */
import type { EngineAction, SerializedElement } from "../../automation/AutomationEngine";
import type {
  PlaybookContext,
  PlaybookStep,
  Playbooks,
  QuoteDraft,
} from "../../automation/WebViewAutomationEngine";
import type { PlatformId } from "../../domain/types";
import {
  type Elements,
  cleanTitle,
  detectCredit,
  detectOtp,
  detectPayment,
  detectReloginNeeded,
  findAddToCart,
  findCartLink,
  findCartRemoveControl,
  findCheckoutButton,
  findNearbyPriceEl,
  findQuantitySelector,
  findResultCard,
  findSearchSubmit,
  findSearchbox,
  isLink,
  isProductHref,
  parseDeliveryDate,
  parseMovPaise,
  parseMrpPaise,
  parsePricePaise,
  parseStockCap,
  parseInStock,
  parseTotalPaise,
  skuIdFromHref,
} from "../selectors";

export interface PlatformLabels {
  readonly platform: PlatformId;
  readonly displayName: string;
}

function reloginAction(name: string): EngineAction {
  return {
    type: "needs_human",
    kind: "otp",
    prompt: `Your ${name} session has expired — please sign in again to continue.`,
  };
}

/**
 * Compose the search query for an item from brand + variant + name + pack size, so the platform
 * returns the specific SKU the retailer asked for (e.g. "India Gate basmati rice 1 kg") instead of a
 * generic match ("rice"). Falls back to the plain name when no refinements are present.
 *
 * Tokens are de-duplicated (case-insensitively, order-preserving) because the parser frequently bakes
 * the brand into the name too (name="milky mist paneer", brand="Milky Mist"), which would otherwise
 * yield an over-stuffed "milky mist milky mist paneer 500 g" that some search boxes match poorly.
 */
export function searchQueryFor(item: PlaybookContext["item"]): string {
  if (!item) return "";
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of [item.brand, item.variant, item.name, item.packSize]) {
    for (const token of (part ?? "").trim().split(/\s+/)) {
      if (token.length === 0) continue;
      const key = token.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push(token);
    }
  }
  return tokens.join(" ");
}

/**
 * The product detail URL for a matched card. Prefer the card's own href; on tiles where the clickable
 * card is a `<div>` (Hyperpure) the link is a nearby `<a>`, so fall back to the closest product-link
 * anchor in the same tile (by bbox proximity). Returns undefined when no product link is present.
 */
function productHref(card: SerializedElement, elements?: Elements): string | undefined {
  if (isProductHref(card.attrs.href)) return card.attrs.href ?? undefined;
  if (!elements) return undefined;
  const [cx, cy] = [card.bbox[0], card.bbox[1]];
  let best: { href: string; dist: number } | undefined;
  for (const el of elements) {
    if (!isLink(el) || !isProductHref(el.attrs.href)) continue;
    const dist = Math.abs(el.bbox[0] - cx) + Math.abs(el.bbox[1] - cy);
    if (!best || dist < best.dist) best = { href: el.attrs.href as string, dist };
  }
  return best?.href;
}

/**
 * Build the `readProduct` extract payload from a matched card, or `null` if price is unreadable. The
 * title and price often live in sibling nodes (Amazon/Hyperpure), so when the card's own text has no
 * price we read it (and MRP/stock) from the nearest priced element in the same tile via `elements`.
 */
export function buildQuoteDraft(
  card: SerializedElement,
  canonicalItemId: string,
  elements?: Elements,
): QuoteDraft | null {
  const priceEl =
    parsePricePaise(card.name) != null
      ? card
      : elements
        ? findNearbyPriceEl(elements, card)
        : undefined;
  const pricePaise = priceEl ? parsePricePaise(priceEl.name) : null;
  if (pricePaise == null || priceEl == null) return null;
  // Title comes from the card; price/MRP/stock from whichever node actually carries the amount. Avoid
  // duplicating when the price is inline (priceEl === card), which would corrupt delivery/stock parsing.
  const text = priceEl.idx === card.idx ? card.name : `${card.name} ${priceEl.name}`;
  const title = cleanTitle(card.name);
  const draft: QuoteDraft = {
    skuId: skuIdFromHref(card.attrs.href, title),
    canonicalItemId,
    title,
    pricePaise,
    mrpPaise: parseMrpPaise(text),
    inStock: parseInStock(text),
    // The card's own link is the product detail page; checkout re-opens it to add the exact SKU.
    productUrl: productHref(card, elements),
    stockCap: parseStockCap(text),
    deliveryDate: parseDeliveryDate(text),
    movPaise: parseMovPaise(text),
  };
  return draft;
}

export function buildPlaybooks(labels: PlatformLabels): Playbooks {
  const { displayName } = labels;

  const typeQuery: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    const box = findSearchbox(els);
    if (!box) return null;
    return { type: "type", idx: box.idx, value: searchQueryFor(ctx.item) };
  };

  const submitSearch: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    const submit = findSearchSubmit(els);
    if (!submit) return null;
    return { type: "click", idx: submit.idx };
  };

  const readProduct: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    if (!ctx.item) return null;
    const card = findResultCard(els, ctx.item);
    if (!card) return null;
    const draft = buildQuoteDraft(card, ctx.item.name, els);
    if (!draft) return null;
    return { type: "extract", data: draft };
  };

  const setQuantity: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    const qty = typeof ctx.state.qty === "number" ? ctx.state.qty : 1;
    // Nothing to set for a single unit; `done` ends this mini-playbook WITHOUT deferring to Claude.
    if (qty <= 1) return { type: "done" };
    const sel = findQuantitySelector(els);
    if (!sel) return { type: "done" }; // No selector (e.g. a +/- stepper) — the add loop handles it.
    if (sel.value != null && sel.value.trim() === String(qty)) return { type: "done" };
    return { type: "select", idx: sel.idx, value: String(qty) };
  };

  const addToCart: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    const skuId = typeof ctx.state.skuId === "string" ? ctx.state.skuId : undefined;
    const btn = findAddToCart(els, skuId);
    if (!btn) return null;
    return { type: "click", idx: btn.idx };
  };

  const clearCart: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    const remove = findCartRemoveControl(els);
    if (!remove) return { type: "done" }; // Cart is already empty — nothing left to remove.
    return { type: "click", idx: remove.idx };
  };

  const checkout: PlaybookStep = (ctx: PlaybookContext): EngineAction | null => {
    const els = ctx.observation.elements;
    if (detectReloginNeeded(els)) return reloginAction(displayName);
    if (detectPayment(els)) {
      return {
        type: "needs_human",
        kind: "payment",
        prompt: `Complete the payment on ${displayName} to place this order.`,
      };
    }
    if (detectOtp(els)) return reloginAction(displayName);
    if (detectCredit(els)) {
      return {
        type: "extract",
        data: { kind: "credit_ok", amountPaise: parseTotalPaise(els) },
      };
    }
    const advance = findCheckoutButton(els) ?? findCartLink(els);
    if (!advance) return null;
    return { type: "click", idx: advance.idx };
  };

  return {
    search: { name: `${labels.platform}:search`, steps: [typeQuery, submitSearch] },
    readProduct: { name: `${labels.platform}:readProduct`, steps: [readProduct] },
    setQuantity: { name: `${labels.platform}:setQuantity`, steps: [setQuantity] },
    addToCart: { name: `${labels.platform}:addToCart`, steps: [addToCart] },
    clearCart: { name: `${labels.platform}:clearCart`, steps: [clearCart] },
    checkout: { name: `${labels.platform}:checkout`, steps: [checkout] },
  };
}
