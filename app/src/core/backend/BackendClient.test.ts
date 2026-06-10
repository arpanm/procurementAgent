import { describe, expect, it, vi } from "vitest";
import { HttpBackendClient, type FetchLike, type ProbeLike } from "./BackendClient";

function okFetch(captured: string[]): FetchLike {
  return async (input) => {
    captured.push(input);
    return { ok: true, status: 200, json: async () => ({ items: [], confidence: 1 }) };
  };
}

describe("HttpBackendClient base-URL resolution", () => {
  it("uses a single configured URL without probing", async () => {
    const urls: string[] = [];
    const probe = vi.fn<ProbeLike>(async () => true);
    const client = new HttpBackendClient("http://localhost:8080", okFetch(urls), probe);

    await client.intent({ text: "x" });

    expect(probe).not.toHaveBeenCalled();
    expect(urls[0]).toBe("http://localhost:8080/intent");
  });

  it("picks the first reachable candidate when several are given", async () => {
    const urls: string[] = [];
    // 10.0.2.2 unreachable (no tunnel-free route), localhost reachable.
    const probe: ProbeLike = async (base) => base.includes("localhost");
    const client = new HttpBackendClient(
      ["http://10.0.2.2:8080", "http://localhost:8080"],
      okFetch(urls),
      probe,
    );

    await client.intent({ text: "x" });

    expect(urls[0]).toBe("http://localhost:8080/intent");
  });

  it("prefers candidate order when multiple are reachable", async () => {
    const urls: string[] = [];
    const probe: ProbeLike = async () => true;
    const client = new HttpBackendClient(
      ["http://10.0.2.2:8080", "http://localhost:8080"],
      okFetch(urls),
      probe,
    );

    await client.intent({ text: "x" });

    expect(urls[0]).toBe("http://10.0.2.2:8080/intent");
  });

  it("caches the resolved URL across calls (probes once)", async () => {
    const urls: string[] = [];
    const probe = vi.fn<ProbeLike>(async () => true);
    const client = new HttpBackendClient(
      ["http://10.0.2.2:8080", "http://localhost:8080"],
      okFetch(urls),
      probe,
    );

    await client.intent({ text: "a" });
    await client.intent({ text: "b" });

    expect(probe).toHaveBeenCalledTimes(2); // both candidates probed once, then cached
    expect(urls).toEqual([
      "http://10.0.2.2:8080/intent",
      "http://10.0.2.2:8080/intent",
    ]);
  });

  it("re-probes after a transport error (e.g. tunnel dropped mid-session)", async () => {
    const urls: string[] = [];
    let reachable = "http://10.0.2.2:8080";
    const probe: ProbeLike = async (base) => base === reachable;
    let failNext = false;
    const fetchImpl: FetchLike = async (input) => {
      if (failNext) {
        failNext = false;
        throw new TypeError("Failed to fetch");
      }
      urls.push(input);
      return { ok: true, status: 200, json: async () => ({ items: [], confidence: 1 }) };
    };
    const client = new HttpBackendClient(
      ["http://10.0.2.2:8080", "http://localhost:8080"],
      fetchImpl,
      probe,
    );

    await client.intent({ text: "first" }); // resolves to 10.0.2.2
    expect(urls[0]).toBe("http://10.0.2.2:8080/intent");

    // The route dies; switch reachability to localhost and make the next fetch throw once.
    reachable = "http://localhost:8080";
    failNext = true;
    await expect(client.intent({ text: "boom" })).rejects.toThrow();

    // Next call must re-probe and switch to the now-reachable localhost.
    await client.intent({ text: "recovered" });
    expect(urls[urls.length - 1]).toBe("http://localhost:8080/intent");
  });

  it("falls back to the first candidate if none answer the probe", async () => {
    const urls: string[] = [];
    const probe: ProbeLike = async () => false;
    const client = new HttpBackendClient(
      ["http://10.0.2.2:8080", "http://localhost:8080"],
      okFetch(urls),
      probe,
    );

    await client.intent({ text: "x" });

    expect(urls[0]).toBe("http://10.0.2.2:8080/intent");
  });
});
