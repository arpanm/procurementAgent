/**
 * Pure, immutable editable-item-list model (PROCURE_COPILOT_PLAN.md Epic 1: "editable parsed item
 * list", "confirmation chips"). The ChatPage UI drives all of its edits through these functions so
 * the list logic is framework-free and fully unit-testable; every mutator returns a NEW array and
 * never mutates its input.
 */
import type { RequestedItem, Unit } from "../domain/types";

/** All units the editor exposes in its unit selector, in display order. */
export const SELECTABLE_UNITS: readonly Unit[] = [
  "kg",
  "g",
  "l",
  "ml",
  "piece",
  "packet",
  "carton",
  "dozen",
] as const;

function isValidIndex(items: readonly RequestedItem[], index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < items.length;
}

/**
 * Returns a new list with the quantity of the item at `index` replaced. Negative/non-finite
 * quantities are clamped to 0 (the UI surfaces 0 as "remove this line"). Out-of-range indices are a
 * no-op (returns the original array reference unchanged).
 */
export function editQty(
  items: readonly RequestedItem[],
  index: number,
  qty: number,
): readonly RequestedItem[] {
  if (!isValidIndex(items, index)) {
    return items;
  }
  const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 0;
  return items.map((item, i) => (i === index ? { ...item, qty: safeQty } : item));
}

/** Returns a new list with the unit of the item at `index` replaced. Out-of-range indices no-op. */
export function editUnit(
  items: readonly RequestedItem[],
  index: number,
  unit: Unit,
): readonly RequestedItem[] {
  if (!isValidIndex(items, index)) {
    return items;
  }
  return items.map((item, i) => (i === index ? { ...item, unit } : item));
}

/** Returns a new list without the item at `index`. Out-of-range indices no-op. */
export function removeItem(
  items: readonly RequestedItem[],
  index: number,
): readonly RequestedItem[] {
  if (!isValidIndex(items, index)) {
    return items;
  }
  return items.filter((_, i) => i !== index);
}

/** Returns a new list with `item` appended to the end. */
export function addItem(
  items: readonly RequestedItem[],
  item: RequestedItem,
): readonly RequestedItem[] {
  return [...items, item];
}

/** Free-text fields on a requested item the editor lets the retailer correct. */
export type ItemTextField = "name" | "brand" | "variant" | "packSize";

/**
 * Returns a new list with a free-text field of the item at `index` replaced. An empty value clears
 * the optional refinement fields (brand/variant/packSize) back to `undefined`; `name` is always kept
 * as a string. Out-of-range indices are a no-op (returns the original array reference unchanged).
 */
export function editTextField(
  items: readonly RequestedItem[],
  index: number,
  field: ItemTextField,
  value: string,
): readonly RequestedItem[] {
  if (!isValidIndex(items, index)) {
    return items;
  }
  return items.map((item, i) => {
    if (i !== index) {
      return item;
    }
    if (field === "name") {
      return { ...item, name: value };
    }
    const cleared = value.trim().length === 0;
    return { ...item, [field]: cleared ? undefined : value };
  });
}

/**
 * Formats a single line, e.g. "5 kg potato", "2 carton refined oil (refined)", or
 * "5 packet India Gate basmati rice (1 kg)". Brand/variant qualify the name; packSize and notes are
 * appended in parentheses. Optional fields are only included when present, so simple items render
 * exactly as before.
 */
function summarizeItem(item: RequestedItem): string {
  const qualifiers = [item.brand, item.variant].filter(Boolean).join(" ");
  const namePart = qualifiers ? `${qualifiers} ${item.name}`.trim() : item.name;
  let base = `${item.qty} ${item.unit} ${namePart}`.trim();
  if (item.packSize) {
    base += ` (${item.packSize})`;
  }
  if (item.notes) {
    base += ` (${item.notes})`;
  }
  return base;
}

/**
 * Produces a plain-language, one-line-per-item summary of the list for read-back / confirmation.
 * Returns an empty string for an empty list.
 */
export function summarize(items: readonly RequestedItem[]): string {
  return items.map(summarizeItem).join("\n");
}
