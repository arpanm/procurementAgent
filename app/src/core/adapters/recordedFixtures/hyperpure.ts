/**
 * Hand-authored Hyperpure HTML fixtures (PROCURE_COPILOT_PLAN.md §9.2). These are STATIC strings
 * approximating Hyperpure's search-results / product / cart pages for known test SKUs — not live
 * scrapes. They exercise the playbooks + selectors deterministically under jsdom via `MockBridge`.
 *
 * Conventions the `mountFixture` helper relies on:
 *  - `data-cart-badge`  the cart count link ("Cart (N)")
 *  - `data-add`         an add-to-cart button (click bumps the cart badge)
 *  - `data-submit`      the search submit button (click mutates its label so the step verifies)
 * Product cards are anchors whose visible text carries title · price · stock · delivery so the
 * serialized `name` is parseable (the perceiver only emits interactable elements, §3.5.4).
 */

const CHROME = `
  <input type="search" aria-label="Search for products on Hyperpure" placeholder="Search for products" />
  <button data-submit>Search</button>
  <a href="/cart" data-cart-badge>Cart (0)</a>
`;

/** Search results for onions / paneer / refined oil — all in stock. */
export const HP_SEARCH_RESULTS = `
  ${CHROME}
  <a href="/hp/p/HP-ONION-10KG">Fresh Red Onion 10kg · ₹250 · In stock · Delivery by Tomorrow</a>
  <button name="add:HP-ONION-10KG" data-add>Add to cart</button>

  <a href="/hp/p/HP-PANEER-1KG">Amul Malai Paneer 1kg · ₹385 · In stock · Delivery by Today</a>
  <button name="add:HP-PANEER-1KG" data-add>Add to cart</button>

  <a href="/hp/p/HP-OIL-5L">Fortune Refined Oil 5L Carton · ₹1,150.00 · In stock · Delivery by Tomorrow</a>
  <button name="add:HP-OIL-5L" data-add>Add to cart</button>
`;

/** Paneer out of stock (no add-to-cart; "Notify me" instead). */
export const HP_OUT_OF_STOCK = `
  ${CHROME}
  <a href="/hp/p/HP-PANEER-1KG">Amul Malai Paneer 1kg · ₹385 · Out of stock · Delivery by Today</a>
  <button name="notify:HP-PANEER-1KG">Notify me</button>
`;

/** Session expired → a login form (password field + "Sign in"); adapter must ask for re-login. */
export const HP_SESSION_EXPIRED = `
  <input type="text" aria-label="Registered phone number" />
  <input type="password" aria-label="Password" />
  <button>Sign in to Hyperpure</button>
`;

/** Moved/renamed search affordance: the searchbox lost its searchy name (layout change, §9.2). */
export const HP_LAYOUT_CHANGE = `
  <input name="q" />
  <button data-submit>Go</button>
  <a href="/cart" data-cart-badge>Cart (0)</a>
  <a href="/hp/p/HP-ONION-10KG">Fresh Red Onion 10kg · ₹250 · In stock · Delivery by Tomorrow</a>
  <button name="add:HP-ONION-10KG" data-add>Add to cart</button>
`;

/** Checkout page where the order is payable on credit. */
export const HP_CHECKOUT_CREDIT = `
  <a href="/cart" data-cart-badge>Cart (1)</a>
  <button>Place order on credit (Order total ₹635)</button>
`;

/** Checkout redirected to OTP entry. */
export const HP_CHECKOUT_OTP = `
  <input aria-label="Enter OTP" />
  <button>Verify OTP</button>
`;

/** Checkout requires an online payment (no credit). */
export const HP_CHECKOUT_PAYMENT = `
  <button>Pay now ₹635 via UPI</button>
`;
