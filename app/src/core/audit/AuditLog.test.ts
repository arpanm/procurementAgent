import { describe, expect, it } from "vitest";
import { InMemorySecureStore } from "../secure/SecureStore";
import { AuditLog, type AuditEntry } from "./AuditLog";

function seed(): { store: InMemorySecureStore; log: AuditLog } {
  const store = new InMemorySecureStore();
  const log = new AuditLog(store, "audit:test");
  return { store, log };
}

describe("AuditLog", () => {
  it("appends a chained trail and reports integrity as true", async () => {
    const { log } = seed();
    await log.append({ actor: "agent", action: "checkout:start", at: "t0" });
    await log.append({ actor: "agent", action: "verify:ok", at: "t1" });
    await log.append({
      actor: "agent",
      action: "order:placed",
      after: { orderRef: "HP-1" },
      at: "t2",
    });

    const entries = await log.entries();
    expect(entries.map((e) => e.action)).toEqual([
      "checkout:start",
      "verify:ok",
      "order:placed",
    ]);
    expect(entries[0].prevHash).toBe("GENESIS");
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);
    expect(await log.verifyIntegrity()).toBe(true);
  });

  it("detects tampering with an entry's content", async () => {
    const { store, log } = seed();
    await log.append({ actor: "agent", action: "order:placed", after: { orderRef: "HP-1" }, at: "t0" });
    await log.append({ actor: "agent", action: "verify:ok", at: "t1" });

    expect(await log.verifyIntegrity()).toBe(true);

    // Tamper with the persisted JSON directly (the hash is left stale).
    const raw = await store.get("audit:test");
    const entries = JSON.parse(raw as string) as AuditEntry[];
    entries[0] = { ...entries[0], after: { orderRef: "HACKED-9999" } };
    await store.set("audit:test", JSON.stringify(entries));

    expect(await log.verifyIntegrity()).toBe(false);
  });

  it("detects a deleted entry", async () => {
    const { store, log } = seed();
    await log.append({ actor: "agent", action: "a", at: "t0" });
    await log.append({ actor: "agent", action: "b", at: "t1" });
    await log.append({ actor: "agent", action: "c", at: "t2" });

    const entries = JSON.parse((await store.get("audit:test")) as string) as AuditEntry[];
    await store.set("audit:test", JSON.stringify([entries[0], entries[2]]));

    expect(await log.verifyIntegrity()).toBe(false);
  });

  it("detects reordered entries", async () => {
    const { store, log } = seed();
    await log.append({ actor: "agent", action: "a", at: "t0" });
    await log.append({ actor: "agent", action: "b", at: "t1" });

    const entries = JSON.parse((await store.get("audit:test")) as string) as AuditEntry[];
    await store.set("audit:test", JSON.stringify([entries[1], entries[0]]));

    expect(await log.verifyIntegrity()).toBe(false);
  });

  it("uses an injected hasher when provided", async () => {
    const store = new InMemorySecureStore();
    const calls: string[] = [];
    const hasher = (input: string): string => {
      calls.push(input);
      return `H(${input.length})`;
    };
    const log = new AuditLog(store, "audit:custom", hasher);
    await log.append({ actor: "agent", action: "x", at: "t0" });
    expect(calls.length).toBeGreaterThan(0);
    expect(await log.verifyIntegrity()).toBe(true);
  });

  it("treats an empty log as intact", async () => {
    const { log } = seed();
    expect(await log.verifyIntegrity()).toBe(true);
    expect(await log.entries()).toEqual([]);
  });
});
