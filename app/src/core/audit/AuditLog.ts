/**
 * Tamper-evident on-device audit log (PROCURE_COPILOT_PLAN.md §2, §7, Epic 6, §9.5). Every actor
 * action around a checkout — cart reads, verify outcomes, OTP/payment hand-offs, order placement — is
 * appended here. The log lives on-device only (backed by {@link SecureStore}); it is NEVER sent to the
 * backend or the Anthropic API.
 *
 * Tamper-evidence is provided by a hash chain: each entry stores `hash(prevHash + payload)`, so
 * mutating, inserting, deleting or reordering any entry breaks the chain and {@link verifyIntegrity}
 * returns false. A genesis hash anchors the first entry.
 *
 * Hashing is injectable (`Hasher`). jsdom may lack `crypto.subtle`, so the default is a small
 * deterministic synchronous hash; production can inject a Web Crypto-backed one.
 */
import type { SecureStore } from "../secure/SecureStore";

/** The hash that anchors the head of the chain (no predecessor). */
export const GENESIS_HASH = "GENESIS";

/** A single audited action. `before`/`after` capture state deltas; `screenshotRef` is on-device. */
export interface AuditEvent {
  readonly actor: string;
  readonly action: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly at: string;
  readonly screenshotRef?: string;
}

/** A committed entry: the event plus its chain position and hashes. */
export interface AuditEntry extends AuditEvent {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** A deterministic string hash. May be sync or async so production can use Web Crypto (SHA-256). */
export type Hasher = (input: string) => string | Promise<string>;

/**
 * Cryptographic SHA-256 hasher over Web Crypto (`crypto.subtle`) — the production default whenever it is
 * available (real Android WebView, modern browsers). Async, hence {@link Hasher} allows a Promise.
 */
export async function sha256Hasher(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** True when Web Crypto SHA-256 is usable in this runtime. */
function hasWebCrypto(): boolean {
  try {
    return typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
  } catch {
    return false;
  }
}

/**
 * The best available hasher: cryptographic SHA-256 when Web Crypto is present (production), else the
 * deterministic {@link defaultHasher} (jsdom / environments without `crypto.subtle`).
 */
export function preferredHasher(): Hasher {
  return hasWebCrypto() ? sha256Hasher : defaultHasher;
}

/**
 * Default hasher — cyrb53, a small deterministic non-cryptographic hash. Good enough to make casual
 * tampering evident in tests and web preview; production uses {@link sha256Hasher} via
 * {@link preferredHasher}.
 */
export function defaultHasher(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, "0");
  const lo = (h1 >>> 0).toString(16).padStart(8, "0");
  return hi + lo;
}

/** Canonical serialization of the event part of an entry — the bytes that are hashed. */
function payloadOf(entry: AuditEntry): string {
  return JSON.stringify({
    seq: entry.seq,
    actor: entry.actor,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
    at: entry.at,
    screenshotRef: entry.screenshotRef ?? null,
  });
}

export class AuditLog {
  constructor(
    private readonly store: SecureStore,
    /** Namespace key so several logs can share one store (e.g. per session). */
    private readonly namespace = "audit:log",
    private readonly hasher: Hasher = defaultHasher,
  ) {}

  private async load(): Promise<AuditEntry[]> {
    const raw = await this.store.get(this.namespace);
    if (raw === null) {
      return [];
    }
    return JSON.parse(raw) as AuditEntry[];
  }

  private async save(entries: readonly AuditEntry[]): Promise<void> {
    await this.store.set(this.namespace, JSON.stringify(entries));
  }

  private async hashOf(entry: AuditEntry): Promise<string> {
    return this.hasher(`${entry.prevHash}|${payloadOf(entry)}`);
  }

  /** Append an event, linking it into the hash chain. Returns the committed entry. */
  async append(event: AuditEvent): Promise<AuditEntry> {
    const entries = await this.load();
    const prevHash = entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1].hash;
    const seq = entries.length;

    const partial: AuditEntry = {
      ...event,
      seq,
      prevHash,
      // Placeholder; replaced below once the real hash is computed over the payload.
      hash: "",
    };
    const hash = await this.hashOf(partial);
    const entry: AuditEntry = { ...partial, hash };

    await this.save([...entries, entry]);
    return entry;
  }

  /** The full ordered trail. */
  async entries(): Promise<readonly AuditEntry[]> {
    return this.load();
  }

  /**
   * Recompute the chain and confirm nothing has been altered: every entry's `prevHash` must equal the
   * predecessor's `hash` (genesis for the head), and every entry's `hash` must match a re-hash of its
   * payload. Any mutation, reordering, insertion or deletion makes this return false.
   */
  async verifyIntegrity(): Promise<boolean> {
    const entries = await this.load();
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.seq !== i) {
        return false;
      }
      if (entry.prevHash !== expectedPrev) {
        return false;
      }
      if ((await this.hashOf(entry)) !== entry.hash) {
        return false;
      }
      expectedPrev = entry.hash;
    }
    return true;
  }
}
