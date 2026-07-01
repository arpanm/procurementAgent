import { describe, expect, it, vi } from "vitest";
import { BackendFailureReporter } from "./failureReporter";
import type { KnowledgeTransport } from "./PlatformKnowledgeStore";
import type { StorageLike } from "./siteMemory";

function fakeTransport(): KnowledgeTransport & { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  return {
    posts,
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockImplementation(async (path: string, body: unknown) => {
      posts.push({ path, body });
      return {};
    }),
  };
}

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const report = { flow: "addToCart", signature: "SKU-1", reason: "not confirmed" };

describe("BackendFailureReporter", () => {
  it("posts a failure to /eval/{platform}/failures with an ISO timestamp", async () => {
    const t = fakeTransport();
    const reporter = new BackendFailureReporter(t, { storage: memStorage(), now: () => 1_000 });

    await reporter.report("hyperpure", report);

    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].path).toBe("/eval/hyperpure/failures");
    expect(t.posts[0].body).toMatchObject({ flow: "addToCart", signature: "SKU-1", at: new Date(1_000).toISOString() });
  });

  it("drops a repeat of the same platform|flow|signature within the cooldown window", async () => {
    const t = fakeTransport();
    let now = 1_000;
    const reporter = new BackendFailureReporter(t, {
      storage: memStorage(),
      cooldownMs: 60 * 60 * 1000,
      now: () => now,
    });

    await reporter.report("hyperpure", report);
    now += 5 * 60 * 1000; // +5 min, still inside the hour
    await reporter.report("hyperpure", report);

    expect(t.posts).toHaveLength(1);
  });

  it("ships again once the cooldown has elapsed", async () => {
    const t = fakeTransport();
    let now = 1_000;
    const reporter = new BackendFailureReporter(t, {
      storage: memStorage(),
      cooldownMs: 60 * 60 * 1000,
      now: () => now,
    });

    await reporter.report("hyperpure", report);
    now += 61 * 60 * 1000; // past the hour
    await reporter.report("hyperpure", report);

    expect(t.posts).toHaveLength(2);
  });

  it("treats a different signature as a separate failure (not deduped)", async () => {
    const t = fakeTransport();
    const reporter = new BackendFailureReporter(t, { storage: memStorage(), now: () => 1_000 });

    await reporter.report("hyperpure", report);
    await reporter.report("hyperpure", { ...report, signature: "SKU-2" });

    expect(t.posts).toHaveLength(2);
  });

  it("persists the cooldown across instances (survives an app relaunch)", async () => {
    const storage = memStorage();
    const t1 = fakeTransport();
    const r1 = new BackendFailureReporter(t1, { storage, now: () => 1_000 });
    await r1.report("hyperpure", report);
    expect(t1.posts).toHaveLength(1);

    // New instance, same storage, still inside the hour → must NOT re-post.
    const t2 = fakeTransport();
    const r2 = new BackendFailureReporter(t2, { storage, now: () => 2_000 });
    await r2.report("hyperpure", report);
    expect(t2.posts).toHaveLength(0);
  });

  it("never throws when the transport rejects", async () => {
    const t: KnowledgeTransport = {
      get: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockRejectedValue(new Error("backend down")),
    };
    const reporter = new BackendFailureReporter(t, { storage: memStorage() });
    await expect(reporter.report("amazon", report)).resolves.toBeUndefined();
  });
});
