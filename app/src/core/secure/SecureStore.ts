/**
 * Secure on-device storage seam (PROCURE_COPILOT_PLAN.md §2, Epic 0). Sessions, cookies and audit
 * live on-device only (Android Keystore-backed / encrypted SQLite). Secrets are never sent to the
 * backend or the Anthropic API. This interface lets the production Keystore implementation be
 * swapped for an in-memory one in tests.
 */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** In-memory implementation for tests and web preview. NOT for production secrets. */
export class InMemorySecureStore implements SecureStore {
  private readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

/**
 * Durable, `localStorage`-backed store so the audit log and idempotency guard survive an app
 * cold-start / reload (the previous production wiring used {@link InMemorySecureStore}, which lost the
 * whole chain on every relaunch). Values are namespaced by {@link prefix} and fall back to an in-memory
 * map when `localStorage` is unavailable (SSR / jsdom without storage).
 *
 * NOTE: this persists but does not ENCRYPT. It is intended for non-secret bookkeeping — audit hashes,
 * idempotency keys, login booleans — which is all that is ever written here (credentials/cookies live in
 * the WebView store; OTPs are never persisted). If truly secret material is ever stored, back this with
 * an Android Keystore / encrypted-SQLite implementation of {@link SecureStore} instead.
 */
export class LocalStorageSecureStore implements SecureStore {
  private readonly fallback = new Map<string, string>();

  constructor(private readonly prefix = "pc.secure.") {}

  private storage(): Storage | null {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<string | null> {
    const ls = this.storage();
    if (!ls) return this.fallback.has(key) ? (this.fallback.get(key) as string) : null;
    return ls.getItem(this.prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    const ls = this.storage();
    if (!ls) {
      this.fallback.set(key, value);
      return;
    }
    ls.setItem(this.prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    const ls = this.storage();
    if (!ls) {
      this.fallback.delete(key);
      return;
    }
    ls.removeItem(this.prefix + key);
  }

  async keys(): Promise<string[]> {
    const ls = this.storage();
    if (!ls) return [...this.fallback.keys()];
    const out: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
    }
    return out;
  }
}
