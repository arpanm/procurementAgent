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
