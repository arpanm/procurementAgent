/**
 * Hand-authored Amazon.in HTML fixtures (PROCURE_COPILOT_PLAN.md §9.2). Static strings approximating
 * Amazon search-results / cart pages for known test SKUs (ASIN-style hrefs, comma-grouped rupee
 * prices, "Get it by …" delivery, "Currently unavailable" stock). Same wiring conventions as the
 * Hyperpure fixtures (`data-cart-badge` / `data-add` / `data-submit`).
 */

const CHROME = `
  <input type="search" aria-label="Search Amazon.in" placeholder="Search Amazon.in" />
  <button name="search-submit" data-submit>Go</button>
  <a href="/gp/cart" data-cart-badge>Cart (0)</a>
`;

/** Search results for onions / paneer / refined oil — all in stock. */
export const AMZ_SEARCH_RESULTS = `
  ${CHROME}
  <a href="/dp/B0ONION10">Fresh Onion 10 kg · ₹260.00 · In stock · Get it by Tomorrow</a>
  <button name="add:B0ONION10" data-add>Add to Cart</button>

  <a href="/dp/B0PANEER1">Amul Malai Paneer 1 kg · ₹399 · In stock · Get it by 12 Jun</a>
  <button name="add:B0PANEER1" data-add>Add to Cart</button>

  <a href="/dp/B0OIL5L">Fortune Refined Sunflower Oil 5 L · ₹1,199.00 · In stock · Get it by 12 Jun</a>
  <button name="add:B0OIL5L" data-add>Add to Cart</button>
`;

/** Paneer currently unavailable. */
export const AMZ_OUT_OF_STOCK = `
  ${CHROME}
  <a href="/dp/B0PANEER1">Amul Malai Paneer 1 kg · ₹399 · Currently unavailable · Get it by 12 Jun</a>
  <button name="notify:B0PANEER1">Notify me</button>
`;

/** Session expired → Amazon sign-in form. */
export const AMZ_SESSION_EXPIRED = `
  <input type="email" aria-label="Email or mobile phone number" />
  <input type="password" aria-label="Amazon password" />
  <button>Sign-In</button>
`;

/** Layout change: the search field no longer advertises itself as search. */
export const AMZ_LAYOUT_CHANGE = `
  <input name="field-keywords" />
  <button data-submit>Go</button>
  <a href="/gp/cart" data-cart-badge>Cart (0)</a>
  <a href="/dp/B0ONION10">Fresh Onion 10 kg · ₹260.00 · In stock · Get it by Tomorrow</a>
  <button name="add:B0ONION10" data-add>Add to Cart</button>
`;

/** Checkout payable on credit (Amazon Business credit line). */
export const AMZ_CHECKOUT_CREDIT = `
  <a href="/gp/cart" data-cart-badge>Cart (1)</a>
  <button>Place order on credit (Order total ₹1,459.00)</button>
`;
