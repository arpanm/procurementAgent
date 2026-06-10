import { afterEach, describe, expect, it } from "vitest";
import { serializeDom } from "./domSerializer";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("serializeDom", () => {
  it("captures interactable elements with idx, name and role, and tags them", () => {
    document.body.innerHTML = `
      <input role="searchbox" aria-label="Search for products" />
      <button id="add">Add to cart</button>
      <span>not interactive</span>
    `;

    const obs = serializeDom(document, window);

    const searchbox = obs.elements.find((e) => e.role === "searchbox");
    const button = obs.elements.find((e) => e.tag === "button");

    expect(searchbox).toBeDefined();
    expect(searchbox?.name).toBe("Search for products");
    expect(searchbox?.tag).toBe("input");

    expect(button).toBeDefined();
    expect(button?.name).toBe("Add to cart");

    // Non-interactive <span> is excluded.
    expect(obs.elements.some((e) => e.tag === "span")).toBe(false);

    // Every captured element is tagged with its idx as data-pc-idx.
    for (const el of obs.elements) {
      const node = document.querySelector(`[data-pc-idx="${el.idx}"]`);
      expect(node).not.toBeNull();
    }
  });

  it("excludes hidden elements (display:none / visibility:hidden / [hidden])", () => {
    document.body.innerHTML = `
      <button id="visible">Visible</button>
      <button id="none" style="display:none">Display none</button>
      <button id="invisible" style="visibility:hidden">Visibility hidden</button>
      <button id="attr" hidden>Hidden attr</button>
    `;

    const obs = serializeDom(document, window);
    const names = obs.elements.map((e) => e.name);

    expect(names).toContain("Visible");
    expect(names).not.toContain("Display none");
    expect(names).not.toContain("Visibility hidden");
    expect(names).not.toContain("Hidden attr");
  });

  it("assigns sequential idx values in document order", () => {
    document.body.innerHTML = `
      <a href="/a">First</a>
      <button>Second</button>
    `;
    const obs = serializeDom(document, window);
    expect(obs.elements.map((e) => e.idx)).toEqual([0, 1]);
    expect(obs.elements.map((e) => e.name)).toEqual(["First", "Second"]);
  });

  it("reports url, title and the cap option", () => {
    document.title = "Test Page";
    document.body.innerHTML = `<button>A</button><button>B</button><button>C</button>`;
    const obs = serializeDom(document, window, { maxElements: 2 });
    expect(obs.title).toBe("Test Page");
    expect(typeof obs.url).toBe("string");
    expect(obs.elements.length).toBe(2);
  });
});
