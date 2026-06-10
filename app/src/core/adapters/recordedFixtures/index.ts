/**
 * Recorded fixtures barrel + a tiny `mountFixture` test helper (PROCURE_COPILOT_PLAN.md §9.2).
 *
 * The fixtures themselves are pure static HTML strings. Because the jsdom environment does not run
 * inline event handlers, `mountFixture` wires the minimal interactivity the engine's
 * `verifyStepEffect` needs — by data-attribute convention, not per-test boilerplate:
 *  - clicking a `[data-add]` button bumps the `[data-cart-badge]` "Cart (N)" count;
 *  - clicking the `[data-submit]` button mutates its own label so a "submit" step verifies.
 */
export * from "./hyperpure";
export * from "./amazon";

function parseCount(text: string | null): number {
  const match = (text ?? "").match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** Mount fixture HTML into a jsdom document and wire convention-based interactivity. */
export function mountFixture(html: string, doc: Document = document): void {
  doc.body.innerHTML = html;

  const badge = doc.querySelector<HTMLElement>("[data-cart-badge]");
  let count = badge ? parseCount(badge.textContent) : 0;

  doc.querySelectorAll<HTMLElement>("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      count += 1;
      if (badge) badge.textContent = `Cart (${count})`;
    });
  });

  const submit = doc.querySelector<HTMLElement>("[data-submit]");
  if (submit) {
    submit.addEventListener("click", () => {
      submit.textContent = `${submit.textContent ?? ""} ✓`;
    });
  }
}
