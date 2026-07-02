import "@testing-library/jest-dom/vitest";

// jsdom ships a `window.scrollBy`/`scrollTo` stub that THROWS "Not implemented" when called, which the
// vision-fallback scroll path (actionExecutor) invokes — flooding test stderr even though the error is
// swallowed. Replace them with no-ops so that path exercises quietly. (L2)
if (typeof window !== "undefined") {
  window.scrollBy = () => {};
  window.scrollTo = () => {};
}
